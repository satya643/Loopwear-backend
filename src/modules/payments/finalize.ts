import type { Order, OrderStatus, Payment, PaymentMethod, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { recordOrderEvent } from "../orders/events";
import { markBuyUnitsSold, tryReReserveOrderInventory } from "../orders/inventory";
import { sendOrderConfirmation } from "../notifications/orderNotifications";
import { refundPaymentFully } from "./refunds";

export type FinalizeSource = "verify" | "webhook" | "reconcile" | "stripe";

export interface FinalizeResult {
  orderId: string;
  orderStatus: OrderStatus;
  outcome: "confirmed" | "already_processed" | "refunded" | "refund_failed";
}

/**
 * The single path from "the gateway says this was paid" to a confirmed
 * order — used by the checkout verify call, the webhook and the
 * reconciliation job. Safe to call any number of times, concurrently:
 *
 * 1. The payment is *claimed* with a guarded UPDATE (pending/failed → paid).
 *    Only one caller can win; every other caller sees 0 rows and returns
 *    `already_processed` without touching anything else. This is what makes
 *    a duplicate webhook, a double-clicked verify, or verify + webhook racing
 *    each other harmless.
 * 2. The order row is locked, then:
 *    - `pending_payment` → confirmed: buy units sold, coupon redeemed, the
 *      purchased cart lines removed (only now — never before payment),
 *      timeline event written.
 *    - already closed (hold expired / superseded, stock released): take
 *      back the same units if they're all still free and confirm; otherwise
 *      the payment is refunded rather than overselling.
 * 3. After commit: confirmation email/SMS, or the refund. Neither can undo
 *    the recorded payment.
 */
export async function finalizeOrderPayment(input: {
  paymentId: string;
  gatewayPaymentRef?: string;
  method?: PaymentMethod;
  source: FinalizeSource;
}): Promise<FinalizeResult> {
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: input.paymentId, status: { in: ["pending", "failed"] } },
      data: {
        status: "paid",
        paidAt: new Date(),
        failureCode: null,
        failureReason: null,
        ...(input.method ? { method: input.method } : {}),
        ...(input.gatewayPaymentRef ? { gatewayPaymentRef: input.gatewayPaymentRef } : {}),
      },
    });
    const payment = await tx.payment.findUniqueOrThrow({ where: { id: input.paymentId } });

    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${payment.orderId} FOR UPDATE`;
    const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });

    if (claimed.count === 0) {
      return { orderId: order.id, orderStatus: order.status, outcome: "already_processed" as const, refund: false };
    }

    if (order.status === "pending_payment") {
      await confirmPaidOrder(tx, order, payment, input.source, false);
      return { orderId: order.id, orderStatus: "confirmed" as OrderStatus, outcome: "confirmed" as const, refund: false };
    }

    if (order.status === "cancelled" || order.status === "payment_failed") {
      if (await tryReReserveOrderInventory(tx, order.id)) {
        await confirmPaidOrder(tx, order, payment, input.source, true);
        return { orderId: order.id, orderStatus: "confirmed" as OrderStatus, outcome: "confirmed" as const, refund: false };
      }
      await recordOrderEvent(tx, {
        orderId: order.id,
        type: "note",
        message: "Payment received after this order was closed, and its items are no longer available — refunding in full",
        actor: "system",
        metadata: { paymentId: payment.id, source: input.source },
      });
      return { orderId: order.id, orderStatus: order.status, outcome: "refunded" as const, refund: true };
    }

    // The order is already paid by another payment (or refunded): this one is extra.
    await recordOrderEvent(tx, {
      orderId: order.id,
      type: "note",
      message: "A duplicate payment was received for this order — refunding it",
      actor: "system",
      metadata: { paymentId: payment.id, source: input.source },
    });
    return { orderId: order.id, orderStatus: order.status, outcome: "refunded" as const, refund: true, extraPayment: true };
  });

  if (result.outcome === "confirmed") {
    await sendOrderConfirmation(result.orderId);
  }
  if (result.refund) {
    const extra = "extraPayment" in result && result.extraPayment;
    const refund = await refundPaymentFully(
      input.paymentId,
      extra ? "Duplicate payment" : "Payment arrived after the order's items were released",
      { actor: "system", markOrderRefunded: !extra }
    );
    if (!refund.ok) return { orderId: result.orderId, orderStatus: result.orderStatus, outcome: "refund_failed" };
    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.orderId }, select: { status: true } });
    return { orderId: result.orderId, orderStatus: order.status, outcome: "refunded" };
  }
  return { orderId: result.orderId, orderStatus: result.orderStatus, outcome: result.outcome };
}

async function confirmPaidOrder(tx: Prisma.TransactionClient, order: Order, payment: Payment, source: FinalizeSource, late: boolean) {
  await tx.order.update({
    where: { id: order.id },
    data: { status: "confirmed", confirmedAt: new Date(), cancelledAt: null, cancelReason: null },
  });
  await markBuyUnitsSold(tx, order.id);

  if (order.couponId) {
    await tx.couponRedemption.upsert({
      where: { orderId: order.id },
      update: {},
      create: { couponId: order.couponId, userId: order.customerId, orderId: order.id, discountPaise: order.discountPaise },
    });
  }

  // The bag is only emptied of what was actually bought, and only now.
  if (order.sourceCartItemIds.length > 0) {
    await tx.cartItem.deleteMany({ where: { id: { in: order.sourceCartItemIds }, cart: { userId: order.customerId } } });
  }
  if (order.couponCode) {
    await tx.cart.updateMany({ where: { userId: order.customerId, couponCode: order.couponCode }, data: { couponCode: null } });
  }

  await recordOrderEvent(tx, {
    orderId: order.id,
    type: "payment_succeeded",
    status: "confirmed",
    message: late ? "Payment received after the hold expired — items re-reserved, order confirmed" : "Payment received — order confirmed",
    actor: "gateway",
    metadata: { paymentId: payment.id, gateway: payment.gateway, gatewayPaymentRef: payment.gatewayPaymentRef, source },
  });
}
