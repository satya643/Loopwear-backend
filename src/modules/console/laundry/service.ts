import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";
import type { LaundryStage } from "@prisma/client";

const BATCH_SEQUENCE: LaundryStage[] = ["received", "washing", "drying", "pressing", "quality", "ready"];

function estimateMinutesFor(priority: "standard" | "rush"): number {
  return priority === "rush" ? 90 : 240;
}

function serializeBatch(batch: any) {
  const now = Date.now();
  const remainingMs = new Date(batch.estimatedCompleteAt).getTime() - now;
  return {
    id: batch.id,
    facilityId: batch.facilityId,
    facility: batch.facility?.name,
    stage: batch.stage,
    priority: batch.priority,
    startedAt: batch.startedAt,
    estimatedCompleteAt: batch.estimatedCompleteAt,
    // Computed at read time from an absolute timestamp — the frontend's
    // eta_minutes was relative and went stale the moment it was read twice
    // (build spec §3 laundry_batches).
    etaMinutes: Math.max(0, Math.round(remainingMs / 60000)),
    garmentCount: batch.items?.length ?? batch._count?.items ?? 0,
  };
}

export async function listBatches() {
  const batches = await prisma.laundryBatch.findMany({
    include: { _count: { select: { items: true } }, facility: { select: { name: true } } },
    orderBy: { startedAt: "desc" },
  });
  return batches.map(serializeBatch);
}

export async function createBatch(input: { facilityId: string; garmentUnitIds: string[]; priority: "standard" | "rush" }) {
  if (input.garmentUnitIds.length === 0) throw ApiError.badRequest("A batch needs at least one garment unit");

  const units = await prisma.garmentUnit.findMany({ where: { id: { in: input.garmentUnitIds } } });
  if (units.length !== input.garmentUnitIds.length) throw ApiError.badRequest("One or more garment units were not found");
  const notInLaundry = units.filter((u) => u.stage !== "laundry");
  if (notInLaundry.length > 0) {
    throw ApiError.conflict("All units must already be in the laundry stage before batching", {
      offendingUnitIds: notInLaundry.map((u) => u.id),
    });
  }

  const batch = await prisma.laundryBatch.create({
    data: {
      facilityId: input.facilityId,
      priority: input.priority,
      estimatedCompleteAt: new Date(Date.now() + estimateMinutesFor(input.priority) * 60 * 1000),
      items: { createMany: { data: input.garmentUnitIds.map((garmentUnitId) => ({ garmentUnitId })) } },
    },
    include: { _count: { select: { items: true } }, facility: { select: { name: true } } },
  });
  return serializeBatch(batch);
}

/**
 * Advances a batch one step. When the batch clears its internal `quality`
 * checkpoint or reaches `ready`, the member units' own GarmentStage advances
 * in lockstep (laundry -> quality -> ready) so the two state machines stay
 * consistent (build spec §3 / §5 laundry advance).
 */
export async function advanceBatch(batchId: string, actorUserId: string) {
  const batch = await prisma.laundryBatch.findUnique({ where: { id: batchId }, include: { items: true } });
  if (!batch) throw ApiError.notFound("Batch not found");

  const currentIndex = BATCH_SEQUENCE.indexOf(batch.stage);
  if (currentIndex === BATCH_SEQUENCE.length - 1) {
    throw ApiError.conflict("Batch has already completed");
  }
  const nextStage = BATCH_SEQUENCE[currentIndex + 1];

  return prisma.$transaction(async (tx) => {
    const updated = await tx.laundryBatch.update({
      where: { id: batchId },
      data: { stage: nextStage },
      include: { _count: { select: { items: true } }, facility: { select: { name: true } } },
    });

    if (nextStage === "quality" || nextStage === "ready") {
      const garmentToStage = nextStage === "quality" ? "quality" : "ready";
      const garmentFromStage = nextStage === "quality" ? "laundry" : "quality";
      for (const item of batch.items) {
        const unit = await tx.garmentUnit.findUnique({ where: { id: item.garmentUnitId } });
        if (!unit || unit.stage !== garmentFromStage) continue;
        await tx.garmentUnit.update({
          where: { id: unit.id },
          data: { stage: garmentToStage, lastMovedAt: new Date() },
        });
        await tx.stageTransition.create({
          data: {
            garmentUnitId: unit.id,
            fromStage: garmentFromStage,
            toStage: garmentToStage,
            actorUserId,
            note: `Laundry batch ${batchId} advanced to ${nextStage}`,
          },
        });
      }
    }

    return serializeBatch(updated);
  });
}
