import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { retrievePaymentIntent, createRefund } from "./stripe";
import { verifyPaymentSignature, createRazorpayRefund } from "./razorpay";
import { BUSINESS_RULES } from "../../config/business";
import type { Condition, Payment, Prisma } from "@prisma/client";

/**
 * Idempotent by gateway_ref (the Stripe PaymentIntent id): re-confirming an
 * already-paid payment, whether triggered by a client retry or a duplicate
 * webhook delivery, is a no-op rather than double-processing the order.
 * Status is always re-verified against Stripe directly — never trust a
 * client-supplied "it succeeded".
 */
export async function confirmPaymentIntent(paymentIntentId: string) {
  const payment = await prisma.payment.findUnique({ where: { gatewayRef: paymentIntentId } });
  if (!payment) throw ApiError.notFound("No payment found for this payment intent");
  if (payment.status === "paid") return payment;

  const intent = await retrievePaymentIntent(paymentIntentId);
  if (intent.status !== "succeeded") {
    if (payment.status !== "failed" && ["canceled", "requires_payment_method"].includes(intent.status)) {
      await prisma.payment.update({ where: { id: payment.id }, data: { status: "failed" } });
    }
    throw ApiError.conflict(`Payment is not completed yet (stripe status: ${intent.status})`);
  }

  const method = intent.payment_method_types?.[0] === "card" ? "card" : "wallet";

  return prisma.$transaction((tx) => finalizePaidPayment(tx, payment, { method }));
}

/**
 * Verifies a Razorpay checkout result and marks the order paid. Idempotent
 * by gateway_ref (the Razorpay order id) for the same reason as the Stripe
 * path above — retries and duplicate client calls are no-ops.
 */
export async function confirmRazorpayPayment(razorpayOrderId: string, razorpayPaymentId: string, signature: string) {
  const payment = await prisma.payment.findUnique({ where: { gatewayRef: razorpayOrderId } });
  if (!payment) throw ApiError.notFound("No payment found for this order");
  if (payment.status === "paid") return payment;

  if (!verifyPaymentSignature(razorpayOrderId, razorpayPaymentId, signature)) {
    throw ApiError.badRequest("Payment signature verification failed");
  }

  return prisma.$transaction((tx) =>
    finalizePaidPayment(tx, payment, { method: "card", gatewayPaymentRef: razorpayPaymentId })
  );
}

/**
 * Same as confirmRazorpayPayment, but for the webhook path: the webhook's
 * own HMAC signature (checked by the caller before this runs) already
 * proves the event is genuine, so there's no separate checkout signature to
 * verify here.
 */
export async function markRazorpayPaymentPaidFromWebhook(razorpayOrderId: string, razorpayPaymentId: string) {
  const payment = await prisma.payment.findUnique({ where: { gatewayRef: razorpayOrderId } });
  if (!payment) throw ApiError.notFound("No payment found for this order");
  if (payment.status === "paid") return payment;

  return prisma.$transaction((tx) =>
    finalizePaidPayment(tx, payment, { method: "card", gatewayPaymentRef: razorpayPaymentId })
  );
}

/**
 * Shared "mark paid + release inventory" logic for every gateway: updates
 * the payment and order, and moves any "buy" line's unit to `sold` for good
 * (it never goes through the rental lifecycle's rented/returned states —
 * not covered by the original frontend spec, but required so a bought unit
 * doesn't linger in the rentable pool). Rent-mode units stay `reserved`
 * until the console dispatches the order (see console/orders/service.ts,
 * which drives reserved -> rented).
 */
async function finalizePaidPayment(
  tx: Prisma.TransactionClient,
  payment: Payment,
  opts: { method: "card" | "wallet"; gatewayPaymentRef?: string }
) {
  const p = await tx.payment.update({
    where: { id: payment.id },
    data: {
      status: "paid",
      method: opts.method,
      ...(opts.gatewayPaymentRef ? { gatewayPaymentRef: opts.gatewayPaymentRef } : {}),
    },
  });
  await tx.order.update({ where: { id: payment.orderId }, data: { status: "confirmed" } });

  const buyItems = await tx.orderItem.findMany({
    where: { orderId: payment.orderId, mode: "buy", garmentUnitId: { not: null } },
  });
  for (const item of buyItems) {
    await tx.garmentUnit.update({
      where: { id: item.garmentUnitId! },
      data: { stage: "sold", currentOrderId: null, lastMovedAt: new Date() },
    });
    await tx.stageTransition.create({
      data: {
        garmentUnitId: item.garmentUnitId!,
        fromStage: "reserved",
        toStage: "sold",
        note: `Sold via order ${payment.orderId}`,
      },
    });
  }

  return p;
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

  const existingRefund = await prisma.refund.findFirst({ where: { orderItemId } });
  if (existingRefund) return existingRefund;

  const condition: Condition = item.garmentUnit?.retiredAt ? "needs_review" : item.garmentUnit?.condition ?? "excellent";
  const pct = item.garmentUnit?.retiredAt
    ? 1 - BUSINESS_RULES.depositForfeitPctIfRetired
    : BUSINESS_RULES.depositRefundPctByCondition[condition] ?? 0;

  const amountPaise = Math.round(item.depositPaise * pct);
  const payment = item.order.payments.find((p) => p.status === "paid");

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
        return prisma.refund.update({
          where: { id: refund.id },
          data: { status: "processed", processedAt: new Date(), gatewayRef: rpRefund.id },
        });
      }

      const stripeRefund = await createRefund(payment.gatewayRef, amountPaise);
      return prisma.refund.update({
        where: { id: refund.id },
        data: { status: "processed", processedAt: new Date(), gatewayRef: stripeRefund.id },
      });
    } catch (err) {
      return prisma.refund.update({ where: { id: refund.id }, data: { status: "failed" } });
    }
  }

  return prisma.refund.update({ where: { id: refund.id }, data: { status: "processed", processedAt: new Date() } });
}
