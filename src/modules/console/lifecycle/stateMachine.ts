import type { GarmentStage } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";

/**
 * Strict transition table (build spec §3). `sold` and `retired` are
 * terminal. `available -> sold` is only ever driven by the payment
 * confirmation flow (see modules/payments/service.ts), not this manual
 * endpoint, since it must happen atomically with order confirmation.
 */
const TRANSITIONS: Record<GarmentStage, GarmentStage[]> = {
  available: ["reserved", "retired"],
  reserved: ["rented", "available"],
  rented: ["returned"],
  returned: ["inspection"],
  inspection: ["laundry", "quality", "retired"],
  laundry: ["quality"],
  quality: ["ready", "retired"],
  ready: ["available"],
  retired: [],
  sold: [],
};

export function isTransitionAllowed(from: GarmentStage, to: GarmentStage): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export interface TransitionInput {
  toStage: GarmentStage;
  note?: string;
  condition?: "excellent" | "good" | "fair" | "needs_review";
  actorUserId: string;
}

/**
 * A unit in `needs_review` must never reach `available`/`ready` — enforced
 * here as an invariant (build spec §3), not left to be "implicitly" true.
 */
export async function transitionGarmentUnit(unitId: string, input: TransitionInput) {
  const unit = await prisma.garmentUnit.findUnique({ where: { id: unitId } });
  if (!unit) throw ApiError.notFound("Garment unit not found");

  if (!isTransitionAllowed(unit.stage, input.toStage)) {
    throw ApiError.conflict(`Cannot move a unit from "${unit.stage}" to "${input.toStage}"`, {
      from: unit.stage,
      to: input.toStage,
    });
  }

  const nextCondition = input.condition ?? unit.condition;
  if ((input.toStage === "ready" || input.toStage === "available") && nextCondition === "needs_review") {
    throw ApiError.conflict('A unit flagged "needs review" cannot move to ready/available — retire it or resolve the condition first');
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.garmentUnit.update({
      where: { id: unitId },
      data: {
        stage: input.toStage,
        condition: nextCondition,
        lastMovedAt: new Date(),
        retiredAt: input.toStage === "retired" ? new Date() : unit.retiredAt,
        currentOrderId: input.toStage === "available" ? null : unit.currentOrderId,
        timesRented: input.toStage === "rented" ? { increment: 1 } : undefined,
      },
    });

    await tx.stageTransition.create({
      data: {
        garmentUnitId: unitId,
        fromStage: unit.stage,
        toStage: input.toStage,
        actorUserId: input.actorUserId,
        note: input.note,
      },
    });

    // Stamps the order_item's actual return date so the customers view can
    // compute an honest on-time rate (build spec §3 customers view) instead
    // of only knowing the promised rentReturnDate.
    if (input.toStage === "returned" && unit.currentOrderId) {
      await tx.orderItem.updateMany({
        where: { garmentUnitId: unitId, orderId: unit.currentOrderId, actualReturnDate: null },
        data: { actualReturnDate: new Date() },
      });
    }

    // Spec: "returned -> inspection (automatic on receipt)" — an operator
    // marking a unit received cascades straight into inspection rather than
    // needing a second manual transition call.
    if (input.toStage === "returned") {
      const inInspection = await tx.garmentUnit.update({
        where: { id: unitId },
        data: { stage: "inspection", lastMovedAt: new Date() },
      });
      await tx.stageTransition.create({
        data: {
          garmentUnitId: unitId,
          fromStage: "returned",
          toStage: "inspection",
          actorUserId: input.actorUserId,
          note: "Auto-advanced to inspection on receipt",
        },
      });
      return inInspection;
    }

    return updated;
  });
}

export async function getLifecycleCounts() {
  const rows = await prisma.garmentUnit.groupBy({ by: ["stage"], _count: { stage: true } });
  const counts: Record<string, number> = {};
  for (const stage of Object.keys(TRANSITIONS)) counts[stage] = 0;
  for (const row of rows) counts[row.stage] = row._count.stage;
  return counts;
}
