import type { Payment } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { BUSINESS_RULES } from "../config/business";
import { closeUnpaidOrder } from "../modules/orders/lifecycle";
import { finalizeOrderPayment } from "../modules/payments/finalize";
import { captureRazorpayPayment, fetchRazorpayOrderPayments, isRazorpayConfigured, mapRazorpayMethod } from "../modules/payments/razorpay";
import { retrievePaymentIntent } from "../modules/payments/stripe";

/**
 * Asks the gateway whether this payment was actually completed (the
 * customer may have paid and the webhook been lost). Finalizes it if so.
 */
async function reconcile(payment: Payment): Promise<boolean> {
  if (!payment.gatewayRef) return false;
  try {
    if (payment.gateway === "razorpay" && isRazorpayConfigured()) {
      const attempts = await fetchRazorpayOrderPayments(payment.gatewayRef);
      let paid = attempts.find((p) => p.status === "captured");
      const authorized = attempts.find((p) => p.status === "authorized");
      if (!paid && authorized) paid = await captureRazorpayPayment(authorized.id, Number(authorized.amount), authorized.currency);
      if (paid && paid.status === "captured" && Number(paid.amount) === payment.chargedAmountMinor) {
        await finalizeOrderPayment({ paymentId: payment.id, gatewayPaymentRef: paid.id, method: mapRazorpayMethod(paid.method), source: "reconcile" });
        return true;
      }
    }
    if (payment.gateway === "stripe") {
      const intent = await retrievePaymentIntent(payment.gatewayRef);
      if (intent.status === "succeeded") {
        await finalizeOrderPayment({ paymentId: payment.id, method: "card", source: "reconcile" });
        return true;
      }
    }
  } catch (err) {
    // Gateway unreachable: don't expire an order we can't confirm is
    // unpaid — try again on the next run.
    // eslint-disable-next-line no-console
    console.warn(`reconcile(${payment.orderId}) failed, will retry next run:`, err instanceof Error ? err.message : err);
    throw err;
  }
  return false;
}

/**
 * Orders still `pending_payment` after their hold (paymentExpiresAt, or
 * createdAt + checkoutHoldMinutes for older rows) are either paid-but-not-
 * yet-recorded or abandoned:
 *  1. reconcile with the gateway — if it was paid, confirm it;
 *  2. otherwise close it: `payment_failed` if an attempt failed, else
 *     `cancelled`; its units go back to stock (orders/lifecycle.ts).
 * Idempotent and safe to run concurrently / on several instances: closing
 * is a guarded status transition. Run via the in-process scheduler
 * (jobs/scheduler.ts) or `npm run jobs:release-reservations`.
 */
export async function runReleaseAbandonedReservationsJob(now: Date = new Date()) {
  const legacyCutoff = new Date(now.getTime() - BUSINESS_RULES.checkoutHoldMinutes * 60 * 1000);
  const stale = await prisma.order.findMany({
    where: {
      status: "pending_payment",
      OR: [{ paymentExpiresAt: { lte: now } }, { paymentExpiresAt: null, createdAt: { lt: legacyCutoff } }],
    },
    include: { payments: { where: { status: { in: ["pending", "failed"] } } }, events: { where: { type: "payment_failed" }, take: 1 } },
    take: 200,
  });

  let released = 0;
  let confirmed = 0;
  for (const order of stale) {
    try {
      let wasPaid = false;
      for (const payment of order.payments) {
        if (await reconcile(payment)) {
          wasPaid = true;
          break;
        }
      }
      if (wasPaid) {
        confirmed += 1;
        continue;
      }

      const attemptFailed = order.events.length > 0 || order.payments.some((p) => p.failureCode || p.failureReason);
      const closed = await prisma.$transaction((tx) =>
        closeUnpaidOrder(tx, order.id, {
          status: attemptFailed ? "payment_failed" : "cancelled",
          eventType: "order_expired",
          reason: attemptFailed
            ? `Payment wasn't completed within ${BUSINESS_RULES.checkoutHoldMinutes} minutes after a failed attempt`
            : `Payment wasn't completed within ${BUSINESS_RULES.checkoutHoldMinutes} minutes`,
          actor: "system",
        })
      );
      if (closed) released += 1;
    } catch {
      // Logged in reconcile(); leave this order for the next run.
    }
  }
  return { checked: stale.length, released, confirmed };
}

if (require.main === module) {
  runReleaseAbandonedReservationsJob()
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`Checked ${r.checked} unpaid order(s): released ${r.released}, confirmed ${r.confirmed} after reconciling`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
