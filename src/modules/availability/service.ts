import type { GarmentStage, OrderStatus, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { BUSINESS_RULES } from "../../config/business";
import { ApiError } from "../../lib/errors";

type Client = PrismaClient | Prisma.TransactionClient;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Orders in these statuses no longer hold stock or rental calendar slots. */
export const INACTIVE_ORDER_STATUSES: OrderStatus[] = ["cancelled", "payment_failed", "refunded"];

/**
 * Stock is always derived from real garment_units (build spec §2 / §7.2),
 * never a stored counter:
 *
 *  - **buy**: a unit in stage `available` with no upcoming or ongoing rental
 *    booking (a unit promised to a renter next week can't be sold today).
 *  - **rent** for [start, end): any unit that isn't retired/sold/held by an
 *    unpaid-or-paid buy order, and whose active rental bookings (+ the
 *    turnaround buffer) don't overlap the window. The `stage` column is a
 *    snapshot of "right now", not a calendar — a unit that's out on rent
 *    today can still be booked for a later window.
 *
 * Scoped by variant (colour) — a "White, M" request is never satisfied by a
 * black unit. Accepts a transaction client so order placement re-runs the
 * exact same check inside its locking transaction (modules/orders/inventory.ts).
 */

export type UnitScope = { variantId: string } | { productId: string };

interface UnitRow {
  id: string;
  variantId: string;
  size: string;
  stage: GarmentStage;
}

interface Booking {
  garmentUnitId: string;
  orderId: string;
  start: Date;
  end: Date;
}

interface UnitCalendar {
  units: UnitRow[];
  bookingsByUnit: Map<string, Booking[]>;
  /** Units held by an active buy order (reserved for, or sold to, a buyer). */
  buyHeld: Set<string>;
}

function scopeWhere(scope: UnitScope): Prisma.GarmentUnitWhereInput {
  return "variantId" in scope ? { variantId: scope.variantId } : { variant: { productId: scope.productId } };
}

async function loadCalendar(
  client: Client,
  where: Prisma.GarmentUnitWhereInput,
  opts: { excludeOrderId?: string } = {}
): Promise<UnitCalendar> {
  const units = await client.garmentUnit.findMany({
    where: { ...where, stage: { notIn: ["retired", "sold"] } },
    select: { id: true, variantId: true, size: true, stage: true },
    orderBy: { id: "asc" },
  });
  const bookingsByUnit = new Map<string, Booking[]>();
  const buyHeld = new Set<string>();
  if (units.length === 0) return { units, bookingsByUnit, buyHeld };

  const items = await client.orderItem.findMany({
    where: {
      garmentUnitId: { in: units.map((u) => u.id) },
      order: {
        status: { notIn: INACTIVE_ORDER_STATUSES },
        ...(opts.excludeOrderId ? { id: { not: opts.excludeOrderId } } : {}),
      },
    },
    select: { garmentUnitId: true, orderId: true, mode: true, rentStartDate: true, rentReturnDate: true },
  });

  for (const item of items) {
    if (!item.garmentUnitId) continue;
    if (item.mode === "buy") {
      buyHeld.add(item.garmentUnitId);
      continue;
    }
    if (!item.rentStartDate || !item.rentReturnDate) continue;
    const list = bookingsByUnit.get(item.garmentUnitId) ?? [];
    list.push({ garmentUnitId: item.garmentUnitId, orderId: item.orderId, start: item.rentStartDate, end: item.rentReturnDate });
    bookingsByUnit.set(item.garmentUnitId, list);
  }
  return { units, bookingsByUnit, buyHeld };
}

function bufferedEnd(booking: Booking): number {
  return booking.end.getTime() + BUSINESS_RULES.turnaroundBufferDays * DAY_MS;
}

function isFreeForRental(cal: UnitCalendar, unit: UnitRow, start: Date, end: Date): boolean {
  if (cal.buyHeld.has(unit.id)) return false;
  const bookings = cal.bookingsByUnit.get(unit.id) ?? [];
  return !bookings.some((b) => b.start < end && bufferedEnd(b) > start.getTime());
}

function isBuyable(cal: UnitCalendar, unit: UnitRow, now: Date): boolean {
  if (unit.stage !== "available" || cal.buyHeld.has(unit.id)) return false;
  const bookings = cal.bookingsByUnit.get(unit.id) ?? [];
  return !bookings.some((b) => bufferedEnd(b) > now.getTime());
}

export async function findFreeRentalUnitIds(
  client: Client,
  scope: UnitScope,
  size: string,
  start: Date,
  end: Date,
  opts: { excludeOrderId?: string } = {}
): Promise<string[]> {
  const cal = await loadCalendar(client, { ...scopeWhere(scope), size }, opts);
  return cal.units.filter((u) => isFreeForRental(cal, u, start, end)).map((u) => u.id);
}

export async function findBuyableUnitIds(
  client: Client,
  scope: UnitScope,
  size: string,
  opts: { excludeOrderId?: string; now?: Date } = {}
): Promise<string[]> {
  const cal = await loadCalendar(client, { ...scopeWhere(scope), size }, opts);
  const now = opts.now ?? new Date();
  return cal.units.filter((u) => isBuyable(cal, u, now)).map((u) => u.id);
}

/** Re-check for ONE unit, used after it's been row-locked (see orders/inventory.ts). */
export async function isUnitAvailableFor(
  client: Client,
  unitId: string,
  req: { mode: "rent" | "buy"; start: Date; end: Date; excludeOrderId?: string }
): Promise<boolean> {
  const cal = await loadCalendar(client, { id: unitId }, { excludeOrderId: req.excludeOrderId });
  const unit = cal.units[0];
  if (!unit) return false;
  return req.mode === "buy" ? isBuyable(cal, unit, new Date()) : isFreeForRental(cal, unit, req.start, req.end);
}

export interface VariantSizeStock {
  variantId: string;
  size: string;
  /** Units free for the requested rental window. */
  rentUnitsFree: number;
  /** Units that can be sold right now. */
  buyUnitsAvailable: number;
}

/** Stock for every (colour, size) of a product, in one pass over its units. */
export async function getVariantStock(productId: string, start: Date, end: Date): Promise<VariantSizeStock[]> {
  if (end <= start) throw ApiError.badRequest("end date must be after start date");
  const cal = await loadCalendar(prisma, { variant: { productId } });
  const now = new Date();
  const byKey = new Map<string, VariantSizeStock>();
  for (const unit of cal.units) {
    const key = `${unit.variantId}::${unit.size}`;
    const entry = byKey.get(key) ?? { variantId: unit.variantId, size: unit.size, rentUnitsFree: 0, buyUnitsAvailable: 0 };
    if (isFreeForRental(cal, unit, start, end)) entry.rentUnitsFree += 1;
    if (isBuyable(cal, unit, now)) entry.buyUnitsAvailable += 1;
    byKey.set(key, entry);
  }
  return [...byKey.values()];
}

/** Stock for one (colour, size) and mode — what add-to-cart checks against. */
export async function countAvailableUnits(
  client: Client,
  req: { variantId: string; size: string; mode: "rent" | "buy"; start: Date; end: Date }
): Promise<number> {
  const ids =
    req.mode === "buy"
      ? await findBuyableUnitIds(client, { variantId: req.variantId }, req.size)
      : await findFreeRentalUnitIds(client, { variantId: req.variantId }, req.size, req.start, req.end);
  return ids.length;
}

export interface SizeAvailability {
  size: string;
  available: boolean;
  unitsFree: number;
}

/** Product-level (all colours) rental availability per size — the PDP's legacy `sizes` field. */
export async function getSizeAvailability(productId: string, start: Date, end: Date): Promise<SizeAvailability[]> {
  const stock = await getVariantStock(productId, start, end);
  const bySize = new Map<string, number>();
  for (const s of stock) bySize.set(s.size, (bySize.get(s.size) ?? 0) + s.rentUnitsFree);
  return [...bySize.entries()].map(([size, unitsFree]) => ({ size, available: unitsFree > 0, unitsFree }));
}

export function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export function defaultRentalWindow(rentDays: number): { start: Date; end: Date } {
  const start = startOfToday();
  return { start, end: new Date(start.getTime() + rentDays * DAY_MS) };
}

/** A rental line's window: its chosen start date (or today) for `rentDays`. */
export function rentalWindow(startDate: Date | null | undefined, rentDays: number): { start: Date; end: Date } {
  const start = startDate ? new Date(startDate) : startOfToday();
  return { start, end: new Date(start.getTime() + rentDays * DAY_MS) };
}
