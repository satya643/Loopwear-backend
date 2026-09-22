import { prisma } from "../lib/prisma";
import { BUSINESS_RULES } from "../config/business";
import { releaseAbandonedOrder } from "../modules/checkout/service";

/**
 * Finds every order still `pending_payment` older than
 * BUSINESS_RULES.checkoutHoldMinutes and releases the units it's holding
 * back to `available` (see releaseAbandonedOrder) — otherwise a customer
 * who closes the payment widget, has a card declined, or just abandons the
 * tab keeps that unit reserved forever, with no way for anyone else to
 * book it. Meant to run on a schedule (e.g. every 5 minutes via cron), the
 * same way jobs/delayedDeliveries.ts does for delivery windows.
 */
export async function runReleaseAbandonedReservationsJob() {
  const cutoff = new Date(Date.now() - BUSINESS_RULES.checkoutHoldMinutes * 60 * 1000);

  const stale = await prisma.order.findMany({
    where: { status: "pending_payment", createdAt: { lt: cutoff } },
    select: { id: true },
  });
  if (stale.length === 0) return 0;

  for (const order of stale) {
    await releaseAbandonedOrder(
      order.id,
      `Released — payment not completed within ${BUSINESS_RULES.checkoutHoldMinutes} minutes of checkout`
    );
  }
  return stale.length;
}

if (require.main === module) {
  runReleaseAbandonedReservationsJob()
    .then((n) => {
      // eslint-disable-next-line no-console
      console.log(`Released ${n} abandoned reservation(s)`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
