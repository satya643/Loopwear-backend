import { prisma } from "../lib/prisma";
import { BUSINESS_RULES } from "../config/business";

/**
 * Cancels orders that have sat in `pending_payment` past
 * BUSINESS_RULES.pendingPaymentReleaseMinutes with no successful/in-flight
 * payment, releasing their reserved garment units back to `available` —
 * mirrors the exact release logic used by the customer/console cancel paths
 * (modules/orders/service.ts, modules/console/orders/service.ts) so all
 * three stay consistent. Idempotent: a second run only ever sees orders
 * still in `pending_payment` (already-cancelled ones don't match the where
 * clause), so re-running it is always safe.
 */
export async function runReleaseStalePendingOrdersJob() {
  const cutoff = new Date(Date.now() - BUSINESS_RULES.pendingPaymentReleaseMinutes * 60 * 1000);

  const staleOrders = await prisma.order.findMany({
    where: {
      status: "pending_payment",
      placedAt: { lt: cutoff },
      payments: { none: { status: { in: ["pending", "paid"] } } },
    },
    include: { items: true },
  });

  for (const order of staleOrders) {
    await prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        if (!item.garmentUnitId) continue;
        const unit = await tx.garmentUnit.findUnique({ where: { id: item.garmentUnitId } });
        if (!unit || unit.stage !== "reserved") continue;
        await tx.garmentUnit.update({
          where: { id: unit.id },
          data: { stage: "available", currentOrderId: null, lastMovedAt: new Date() },
        });
        await tx.stageTransition.create({
          data: {
            garmentUnitId: unit.id,
            fromStage: "reserved",
            toStage: "available",
            note: `Released: order ${order.id} auto-cancelled after ${BUSINESS_RULES.pendingPaymentReleaseMinutes}min unpaid`,
          },
        });
      }
      await tx.order.update({ where: { id: order.id }, data: { status: "cancelled" } });
    });
  }

  return staleOrders.length;
}

if (require.main === module) {
  runReleaseStalePendingOrdersJob()
    .then((n) => {
      // eslint-disable-next-line no-console
      console.log(`Released ${n} stale pending_payment order(s)`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
