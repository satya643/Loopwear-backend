import type { GarmentStage, Prisma } from "@prisma/client";
import { ApiError } from "../../lib/errors";
import { findBuyableUnitIds, findFreeRentalUnitIds, isUnitAvailableFor } from "../availability/service";

type Tx = Prisma.TransactionClient;

export interface AllocationRequest {
  variantId: string;
  size: string;
  mode: "rent" | "buy";
  quantity: number;
  start: Date;
  end: Date;
  /** Product name, only for the error message. */
  label: string;
}

export interface AllocatedUnit {
  id: string;
  stage: GarmentStage;
}

/**
 * Picks and row-locks `quantity` physical units for one order line, inside
 * the caller's transaction.
 *
 * The candidate list is read without locks, so by the time we lock a
 * candidate another checkout may already have committed a booking for it.
 * Each candidate is therefore locked with FOR UPDATE SKIP LOCKED (a unit
 * another open checkout holds is skipped, never waited on — no deadlocks)
 * and then **re-checked under the lock**; Postgres read-committed means that
 * re-check sees everything committed before the lock was granted. Two
 * concurrent orders for the last unit: one gets it, the other gets
 * `out_of_stock` (409) and nothing is persisted.
 *
 * `taken` carries units already picked for earlier lines of the same order
 * (a rent line and a buy line for the same colour/size must not share one).
 */
export async function allocateUnits(tx: Tx, req: AllocationRequest, taken: Set<string>): Promise<AllocatedUnit[]> {
  const candidates =
    req.mode === "buy"
      ? await findBuyableUnitIds(tx, { variantId: req.variantId }, req.size)
      : await findFreeRentalUnitIds(tx, { variantId: req.variantId }, req.size, req.start, req.end);

  const picked: AllocatedUnit[] = [];
  for (const id of candidates) {
    if (picked.length === req.quantity) break;
    if (taken.has(id)) continue;

    const locked = await tx.$queryRaw<{ id: string; stage: GarmentStage }[]>`
      SELECT id, stage FROM "GarmentUnit"
      WHERE id = ${id} AND stage NOT IN ('retired', 'sold')
      FOR UPDATE SKIP LOCKED
    `;
    if (locked.length === 0) continue;
    if (!(await isUnitAvailableFor(tx, id, { mode: req.mode, start: req.start, end: req.end }))) continue;

    picked.push(locked[0]);
    taken.add(id);
  }

  if (picked.length < req.quantity) {
    const message =
      picked.length === 0
        ? `${req.label} (${req.size}) is out of stock`
        : `Only ${picked.length} of ${req.label} (${req.size}) ${picked.length === 1 ? "is" : "are"} available`;
    throw ApiError.conflict(
      message,
      { variantId: req.variantId, size: req.size, mode: req.mode, requested: req.quantity, available: picked.length },
      "out_of_stock"
    );
  }
  return picked;
}

/**
 * Marks allocated units as held by `orderId`. A unit that's `available`
 * moves to `reserved`. A rental unit booked for a future window while it's
 * busy elsewhere (out on rent, in laundry…) keeps its current stage and
 * owner — the booking lives on the OrderItem's dates, and overwriting the
 * live stage would corrupt the other rental's lifecycle.
 */
export async function reserveUnits(tx: Tx, orderId: string, units: AllocatedUnit[], note: string) {
  for (const unit of units) {
    if (unit.stage !== "available") continue;
    await tx.garmentUnit.update({
      where: { id: unit.id },
      data: { stage: "reserved", currentOrderId: orderId, lastMovedAt: new Date() },
    });
    await tx.stageTransition.create({
      data: { garmentUnitId: unit.id, fromStage: "available", toStage: "reserved", note },
    });
  }
}

/** Releases only units this order is actually holding (never another order's). */
export async function releaseOrderInventory(tx: Tx, orderId: string, note: string, actorUserId?: string) {
  const units = await tx.garmentUnit.findMany({ where: { currentOrderId: orderId, stage: "reserved" }, select: { id: true } });
  for (const unit of units) {
    await tx.garmentUnit.update({
      where: { id: unit.id },
      data: { stage: "available", currentOrderId: null, lastMovedAt: new Date() },
    });
    await tx.stageTransition.create({
      data: { garmentUnitId: unit.id, fromStage: "reserved", toStage: "available", actorUserId, note },
    });
  }
  return units.length;
}

/** Buy units leave circulation for good once their order is paid. */
export async function markBuyUnitsSold(tx: Tx, orderId: string) {
  const items = await tx.orderItem.findMany({
    where: { orderId, mode: "buy", garmentUnitId: { not: null } },
    select: { garmentUnitId: true },
  });
  for (const item of items) {
    const updated = await tx.garmentUnit.updateMany({
      where: { id: item.garmentUnitId!, currentOrderId: orderId, stage: "reserved" },
      data: { stage: "sold", currentOrderId: null, lastMovedAt: new Date() },
    });
    if (updated.count === 0) continue;
    await tx.stageTransition.create({
      data: { garmentUnitId: item.garmentUnitId!, fromStage: "reserved", toStage: "sold", note: `Sold via order ${orderId}` },
    });
  }
}

/**
 * A paid buy order cancelled before it was packed: its units never left the
 * facility, so they go back into stock (the one sanctioned exit from `sold`).
 */
export async function returnSoldUnitsToStock(tx: Tx, orderId: string, note: string, actorUserId?: string) {
  const items = await tx.orderItem.findMany({
    where: { orderId, mode: "buy", garmentUnitId: { not: null } },
    select: { garmentUnitId: true },
  });
  for (const item of items) {
    const updated = await tx.garmentUnit.updateMany({
      where: { id: item.garmentUnitId!, stage: "sold" },
      data: { stage: "available", currentOrderId: null, lastMovedAt: new Date() },
    });
    if (updated.count === 0) continue;
    await tx.stageTransition.create({
      data: { garmentUnitId: item.garmentUnitId!, fromStage: "sold", toStage: "available", actorUserId, note },
    });
  }
}

/**
 * A payment that arrives after the order's hold expired (its units were
 * released): try to take back exactly the same units. All-or-nothing — if
 * any unit has since been booked by someone else, returns false and the
 * caller refunds instead of overselling.
 */
export async function tryReReserveOrderInventory(tx: Tx, orderId: string): Promise<boolean> {
  const items = await tx.orderItem.findMany({
    where: { orderId, garmentUnitId: { not: null } },
    select: { garmentUnitId: true, mode: true, rentStartDate: true, rentReturnDate: true },
  });
  const now = new Date();
  const units: AllocatedUnit[] = [];
  for (const item of items) {
    const locked = await tx.$queryRaw<{ id: string; stage: GarmentStage }[]>`
      SELECT id, stage FROM "GarmentUnit"
      WHERE id = ${item.garmentUnitId} AND stage NOT IN ('retired', 'sold')
      FOR UPDATE SKIP LOCKED
    `;
    if (locked.length === 0) return false;
    const free = await isUnitAvailableFor(tx, item.garmentUnitId!, {
      mode: item.mode,
      start: item.rentStartDate ?? now,
      end: item.rentReturnDate ?? now,
      excludeOrderId: orderId,
    });
    if (!free) return false;
    units.push(locked[0]);
  }
  await reserveUnits(tx, orderId, units, `Re-reserved: late payment for order ${orderId}`);
  return true;
}
