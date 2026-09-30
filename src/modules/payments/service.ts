import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { retrievePaymentIntent, createRefund } from "./stripe";
import {
  captureRazorpayPayment,
  createRazorpayRefund,
  fetchRazorpayPayment,
  mapRazorpayMethod,
  verifyPaymentSignature,
} from "./razorpay";
import { finalizeOrderPayment, type FinalizeResult } from "./finalize";
import { syncPaymentRefundStatus } from "./refunds";
import { closeUnpaidOrder } from "../orders/lifecycle";
import { recordOrderEvent } from "../orders/events";
import { notifyOps } from "../notifications/orderNotifications";
import { BUSINESS_RULES } from "../../config/business";
import type { Condition, OrderActor, Payment } from "@prisma/client";

export type VerifyOutcome =
  | { status: "confirmed" | "already_processed" | "refunded" | "refund_failed"; result: FinalizeResult; payment: Payment }
  | { status: "processing"; orderId: string; payment: Payment };

/**
 * Verifies what Razorpay Checkout handed the browser, then asks Razorpay
 * itself before confirming anything:
 *   1. the payment row exists and belongs to the caller (IDOR guard → 404);
 *   2. HMAC(order_id|payment_id) matches the signature (it can't be forged
 *      without our key secret);
 *   3. the payment fetched from Razorpay is for this order, captured
 *      (captured here if the account leaves it `authorized`), and for
 *      exactly the amount and currency we asked for.
 * If Razorpay can't be reached right now the result is `processing`: the
 * webhook or the reconciliation job completes it, and the client polls.
 */
export async function verifyRazorpayCheckout(
  userId: string,
  input: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }
): Promise<VerifyOutcome> {
  const payment = await prisma.payment.findUnique({ where: { gatewayRef: input.razorpay_order_id } });
  if (!payment || payment.customerId !== userId || payment.gateway !== "razorpay") {
    throw ApiError.notFound("No payment found for this order");
  }
  if (!verifyPaymentSignature(input.razorpay_order_id, input.razorpay_payment_id, input.razorpay_signature)) {
    throw ApiError.badRequest("Payment signature verification failed", undefined, "payment_verification_failed");
  }
  if (payment.status === "paid") {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: payment.orderId }, select: { status: true } });
    return { status: "already_processed", result: { orderId: payment.orderId, orderStatus: order.status, outcome: "already_processed" }, payment };
  }

  let rp: Awaited<ReturnType<typeof fetchRazorpayPayment>>;
  try {
    rp = await fetchRazorpayPayment(input.razorpay_payment_id);
    if (rp.status === "authorized") rp = await captureRazorpayPayment(rp.id, Number(rp.amount), rp.currency);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`verifyRazorpayCheckout: Razorpay unreachable for ${input.razorpay_payment_id}, deferring to webhook/reconcile`, err);
    return { status: "processing", orderId: payment.orderId, payment };
  }

  if (rp.order_id !== input.razorpay_order_id) {
    throw ApiError.badRequest("This payment doesn't belong to this order", undefined, "payment_verification_failed");
  }
  if (rp.status === "failed") {
    await recordPaymentFailure(payment.orderId, userId, {
      kind: "failed",
      razorpayPaymentId: rp.id,
      code: rp.error_code ?? undefined,
      description: rp.error_description ?? undefined,
      actor: "gateway",
    });
    throw ApiError.conflict(rp.error_description || "The payment failed", { orderId: payment.orderId, retryable: true }, "payment_verification_failed");
  }
  if (rp.status !== "captured") {
    return { status: "processing", orderId: payment.orderId, payment };
  }
  if (Number(rp.amount) !== payment.chargedAmountMinor || rp.currency !== payment.chargedCurrency) {
    await recordOrderEvent(prisma, {
      orderId: payment.orderId,
      type: "note",
      message: "Payment amount didn't match the order — held for review",
      actor: "system",
      metadata: { expected: payment.chargedAmountMinor, received: Number(rp.amount), currency: rp.currency, razorpayPaymentId: rp.id },
    });
    await notifyOps("danger", "Payment amount mismatch", `Razorpay payment ${rp.id} for order ${payment.orderId} was ${rp.amount} ${rp.currency}, expected ${payment.chargedAmountMinor} ${payment.chargedCurrency}.`, payment.orderId);
    throw ApiError.conflict("We couldn't verify this payment. Our team has been notified.", { orderId: payment.orderId }, "payment_verification_failed");
  }

  const result = await finalizeOrderPayment({
    paymentId: payment.id,
    gatewayPaymentRef: rp.id,
    method: mapRazorpayMethod(rp.method),
    source: "verify",
  });
  return { status: result.outcome, result, payment };
}

/**
 * A failed attempt or a closed payment window. Informational only — it
 * never changes money state: the order stays payable (same Razorpay order)
 * until its hold expires. Repeats for the same Razorpay payment id (client
 * callback + webhook) are recorded once.
 */
export async function recordPaymentFailure(
  orderId: string,
  userId: string | null,
  input: {
    kind: "failed" | "dismissed";
    razorpayPaymentId?: string;
    code?: string;
    description?: string;
    reason?: string;
    actor: OrderActor;
  }
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || (userId && order.customerId !== userId)) throw ApiError.notFound("Order not found");
  const state = { orderId, status: order.status, retryable: order.status === "pending_payment", paymentExpiresAt: order.paymentExpiresAt };
  if (order.status !== "pending_payment") return state;

  if (input.kind === "dismissed") {
    await recordOrderEvent(prisma, {
      orderId,
      type: "payment_cancelled",
      message: "Payment window closed before the payment was completed",
      actor: input.actor,
      actorUserId: userId,
    });
    return state;
  }

  if (input.razorpayPaymentId) {
    const seen = await prisma.orderEvent.findFirst({
      where: { orderId, type: "payment_failed", metadata: { path: ["razorpayPaymentId"], equals: input.razorpayPaymentId } },
    });
    if (seen) return state;
  }
  const description = input.description?.slice(0, 300) || "The payment was declined";
  await prisma.payment.updateMany({
    where: { orderId, status: "pending" },
    data: { failureCode: input.code?.slice(0, 100) ?? "payment_failed", failureReason: description },
  });
  await recordOrderEvent(prisma, {
    orderId,
    type: "payment_failed",
    message: `Payment failed: ${description}`,
    actor: input.actor,
    actorUserId: userId,
    metadata: { razorpayPaymentId: input.razorpayPaymentId ?? null, code: input.code ?? null, reason: input.reason ?? null },
  });
  return state;
}

/**
 * Stripe lane (non-INR display currencies). Status is always re-read from
 * Stripe — never a client claim — and confirmation goes through the same
 * idempotent finalizeOrderPayment as Razorpay.
 *
 * `expectedUserId` is omitted only by the signature-verified webhook; every
 * customer-facing caller passes it (IDOR guard, mismatch reads as 404).
 */
export async function confirmPaymentIntent(paymentIntentId: string, expectedUserId?: string) {
  const payment = await prisma.payment.findUnique({ where: { gatewayRef: paymentIntentId } });
  if (!payment || (expectedUserId && payment.customerId !== expectedUserId)) {
    throw ApiError.notFound("No payment found for this payment intent");
  }
  if (payment.status === "paid") return prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });

  const intent = await retrievePaymentIntent(paymentIntentId);
  if (intent.status !== "succeeded") {
    // "canceled" is Stripe's terminal failure — release the stock now rather
    // than at hold expiry. "requires_payment_method" is a failed attempt the
    // customer may retry on the same intent, so the order stays payable.
    if (intent.status === "canceled") {
      await prisma.$transaction((tx) =>
        closeUnpaidOrder(tx, payment.orderId, {
          status: "payment_failed",
          eventType: "order_expired",
          reason: "Payment was cancelled at the gateway",
          actor: "gateway",
        })
      );
    } else if (intent.status === "requires_payment_method") {
      await recordPaymentFailure(payment.orderId, null, {
        kind: "failed",
        description: intent.last_payment_error?.message ?? "The card was declined",
        code: intent.last_payment_error?.code ?? undefined,
        actor: "gateway",
      });
    }
    throw ApiError.conflict(`Payment is not completed yet (stripe status: ${intent.status})`, { orderId: payment.orderId }, "payment_verification_failed");
  }

  const method = intent.payment_method_types?.[0] === "card" ? "card" : "wallet";
  await finalizeOrderPayment({ paymentId: payment.id, method, source: expectedUserId ? "stripe" : "webhook" });
  return prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
}

/**
 * Deposit refund on return, per build spec §7.9 / §8.2. Percentage withheld
 * is keyed by the unit's condition at inspection — see BUSINESS_RULES for
 * the actual numbers (defaults, confirm with finance before production use).
 */
export async function refundDepositForOrderItem(orderItemId: string, actorUserId: string) {
  const item = await prisma.orderItem.findUnique({
    where: { id: orderItemId },
    include: { garmentUnit: true, order: { include: { payments: true } } },
  });
  if (!item) throw ApiError.notFound("Order item not found");
  if (item.mode !== "rent") throw ApiError.badRequest("Only rental items carry a refundable deposit");
  if (item.depositPaise === 0) throw ApiError.badRequest("This item has no deposit to refund");
  if (!item.actualReturnDate) {
    throw ApiError.badRequest(
      "This item hasn't been marked returned yet — a deposit can only be refunded after return/inspection"
    );
  }

  const existingRefund = await prisma.refund.findFirst({ where: { orderItemId } });
  if (existingRefund) return existingRefund;

  const condition: Condition = item.garmentUnit?.retiredAt ? "needs_review" : item.garmentUnit?.condition ?? "excellent";
  const pct = item.garmentUnit?.retiredAt
    ? 1 - BUSINESS_RULES.depositForfeitPctIfRetired
    : BUSINESS_RULES.depositRefundPctByCondition[condition] ?? 0;

  const amountPaise = Math.round(item.depositPaise * pct);
  const payment = item.order.payments.find((p) => p.status === "paid" || p.status === "partially_refunded");

  const refund = await prisma.refund.create({
    data: {
      orderItemId,
      paymentId: payment?.id,
      amountPaise,
      reason: `condition:${condition}`,
      status: "pending",
      actorUserId,
    },
  });

  if (amountPaise > 0 && payment?.gatewayRef) {
    try {
      if (payment.gateway === "razorpay") {
        if (!payment.gatewayPaymentRef) throw new Error("Razorpay payment has no charge id to refund");
        const rpRefund = await createRazorpayRefund(payment.gatewayPaymentRef, amountPaise);
        const processed = await prisma.refund.update({
          where: { id: refund.id },
          data: { status: "processed", processedAt: new Date(), gatewayRef: rpRefund.id },
        });
        await syncPaymentRefundStatus(payment.id);
        return processed;
      }

      const stripeRefund = await createRefund(payment.gatewayRef, amountPaise);
      const processed = await prisma.refund.update({
        where: { id: refund.id },
        data: { status: "processed", processedAt: new Date(), gatewayRef: stripeRefund.id },
      });
      await syncPaymentRefundStatus(payment.id);
      return processed;
    } catch (err) {
      return prisma.refund.update({ where: { id: refund.id }, data: { status: "failed" } });
    }
  }

  const processed = await prisma.refund.update({
    where: { id: refund.id },
    data: { status: "processed", processedAt: new Date() },
  });
  await syncPaymentRefundStatus(payment?.id);
  return processed;
}
