import type { OrderActor } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { createRazorpayRefund } from "./razorpay";
import { createRefund as createStripeRefund } from "./stripe";
import { recordOrderEvent } from "../orders/events";
import { notifyOps } from "../notifications/orderNotifications";

function inr(paise: number) {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/**
 * `Payment.status` follows the sum of its non-failed refunds vs. what it
 * charged: all of it → refunded, some → partially_refunded.
 */
export async function syncPaymentRefundStatus(paymentId?: string | null): Promise<void> {
  if (!paymentId) return;
  const [payment, refundedAgg] = await Promise.all([
    prisma.payment.findUnique({ where: { id: paymentId } }),
    prisma.refund.aggregate({ where: { paymentId, status: { not: "failed" } }, _sum: { amountPaise: true } }),
  ]);
  if (!payment) return;
  const refundedTotal = refundedAgg._sum.amountPaise ?? 0;
  if (refundedTotal <= 0) return;
  const nextStatus = refundedTotal >= payment.amountPaise ? "refunded" : "partially_refunded";
  if (payment.status !== nextStatus) await prisma.payment.update({ where: { id: paymentId }, data: { status: nextStatus } });
}

/**
 * Refunds whatever is left of a payment. Used for cancellations after
 * payment and for a payment that arrived after its order could no longer
 * be fulfilled. The gateway call happens outside any DB transaction; if it
 * fails the Refund row is marked failed, the order gets a note and ops are
 * alerted — nothing is silently dropped.
 *
 * `markOrderRefunded: false` refunds just this payment (e.g. a second
 * payment on an order that's already confirmed by another one).
 */
export async function refundPaymentFully(
  paymentId: string,
  reason: string,
  opts: { actor: OrderActor; actorUserId?: string; markOrderRefunded?: boolean }
): Promise<{ ok: boolean }> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId }, include: { refunds: true } });
  if (!payment || !["paid", "partially_refunded"].includes(payment.status)) return { ok: false };

  const alreadyRefunded = payment.refunds.filter((r) => r.status !== "failed").reduce((sum, r) => sum + r.amountPaise, 0);
  const amountPaise = payment.amountPaise - alreadyRefunded;
  if (amountPaise <= 0) return { ok: true };

  const refund = await prisma.refund.create({
    data: { orderId: payment.orderId, paymentId, amountPaise, reason, status: "pending", actorUserId: opts.actorUserId },
  });
  // Refund in the currency actually charged, proportionally.
  const amountMinor = Math.round((amountPaise * payment.chargedAmountMinor) / payment.amountPaise);

  try {
    let gatewayRef: string | null = null;
    let settled = true;
    if (payment.gateway === "razorpay") {
      if (!payment.gatewayPaymentRef) throw new Error("Razorpay payment has no payment id to refund");
      const rp = await createRazorpayRefund(payment.gatewayPaymentRef, amountMinor, { orderId: payment.orderId, refundId: refund.id });
      gatewayRef = rp.id;
      settled = rp.status === "processed";
    } else if (payment.gateway === "stripe") {
      if (!payment.gatewayRef) throw new Error("Stripe payment has no PaymentIntent to refund");
      const sr = await createStripeRefund(payment.gatewayRef, amountMinor);
      gatewayRef = sr.id;
      settled = sr.status === "succeeded";
    }

    await prisma.$transaction(async (tx) => {
      await tx.refund.update({
        where: { id: refund.id },
        data: { gatewayRef, status: settled ? "processed" : "pending", processedAt: settled ? new Date() : null },
      });
      if (opts.markOrderRefunded !== false) {
        await tx.order.update({ where: { id: payment.orderId }, data: { status: "refunded" } });
      }
      await recordOrderEvent(tx, {
        orderId: payment.orderId,
        type: "refunded",
        status: opts.markOrderRefunded !== false ? "refunded" : undefined,
        message: `Refund of ${inr(amountPaise)} ${settled ? "processed" : "initiated"} — ${reason}`,
        actor: opts.actor,
        actorUserId: opts.actorUserId,
        metadata: { refundId: refund.id, gatewayRef, paymentId },
      });
    });
    await syncPaymentRefundStatus(paymentId);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.refund.update({ where: { id: refund.id }, data: { status: "failed" } });
    await recordOrderEvent(prisma, {
      orderId: payment.orderId,
      type: "note",
      message: `Automatic refund of ${inr(amountPaise)} failed — our team will refund it manually`,
      actor: "system",
      metadata: { refundId: refund.id, error: message },
    });
    await notifyOps("danger", "Refund failed", `Refund of ${inr(amountPaise)} for order ${payment.orderId} (${reason}) failed: ${message}`, payment.orderId);
    return { ok: false };
  }
}
