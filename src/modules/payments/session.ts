import { Prisma, type Order, type Payment } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { ApiError } from "../../lib/errors";
import { convertPaise } from "../../lib/fx";
import { recordOrderEvent } from "../orders/events";
import { createRazorpayOrder, isRazorpayConfigured } from "./razorpay";
import { createPaymentIntent, retrievePaymentIntent } from "./stripe";

export type PaymentSession =
  | {
      gateway: "razorpay";
      paymentId: string;
      orderId: string;
      razorpayOrderId: string;
      keyId: string;
      amount: number;
      currency: string;
      expiresAt: Date | null;
      prefill: { name: string; email: string; contact: string };
    }
  | {
      gateway: "stripe";
      paymentId: string;
      orderId: string;
      clientSecret: string;
      amount: number;
      currency: string;
      expiresAt: Date | null;
    };

const PAID_OR_LATER: Order["status"][] = ["confirmed", "packed", "shipped", "with_customer", "return_in_transit", "closed"];

/** An order can only be paid while it's awaiting payment and its hold hasn't run out. */
export function assertOrderPayable(order: Order) {
  if (PAID_OR_LATER.includes(order.status)) {
    throw ApiError.conflict("This order has already been paid", { orderId: order.id, status: order.status }, "order_not_payable");
  }
  if (order.status !== "pending_payment") {
    throw ApiError.gone("This order is no longer awaiting payment — please check out again", { orderId: order.id, status: order.status }, "order_not_payable");
  }
  if (order.paymentExpiresAt && order.paymentExpiresAt <= new Date()) {
    throw ApiError.gone(
      "The time to pay for this order ran out and its items were released — please check out again",
      { orderId: order.id },
      "order_expired"
    );
  }
}

/**
 * Returns what the browser needs to open the payment widget for an order,
 * creating the gateway order the first time and **reusing it on every
 * retry** — Razorpay lets a customer make several attempts against one
 * order until one succeeds, so a failed/dismissed attempt never needs a new
 * order (and the partial unique index guarantees one active payment per
 * order anyway). INR goes through Razorpay; other display currencies keep
 * the existing Stripe lane.
 */
export async function createPaymentSession(orderId: string, userId?: string): Promise<PaymentSession> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { customer: true } });
  if (!order || (userId && order.customerId !== userId)) throw ApiError.notFound("Order not found");
  assertOrderPayable(order);

  const amountPaise = order.totalPaise + order.depositTotalPaise;
  const chargedAmountMinor = convertPaise(amountPaise, order.fxRateToBase);
  const useRazorpay = order.currency === "INR" && isRazorpayConfigured();
  const gateway = useRazorpay ? "razorpay" : "stripe";
  const prefill = {
    name: order.deliveryName ?? order.customer.name,
    email: order.deliveryEmail ?? order.customer.email,
    contact: order.deliveryPhone ?? order.customer.phone ?? "",
  };

  const toSession = async (payment: Payment): Promise<PaymentSession> => {
    if (payment.gateway === "razorpay") {
      return {
        gateway: "razorpay",
        paymentId: payment.id,
        orderId: order.id,
        razorpayOrderId: payment.gatewayRef!,
        keyId: env.razorpay.keyId,
        amount: payment.chargedAmountMinor,
        currency: payment.chargedCurrency,
        expiresAt: order.paymentExpiresAt,
        prefill,
      };
    }
    const intent = await retrievePaymentIntent(payment.gatewayRef!);
    return {
      gateway: "stripe",
      paymentId: payment.id,
      orderId: order.id,
      clientSecret: intent.client_secret!,
      amount: payment.chargedAmountMinor,
      currency: payment.chargedCurrency,
      expiresAt: order.paymentExpiresAt,
    };
  };

  const existing = await prisma.payment.findFirst({ where: { orderId, status: "pending" }, orderBy: { createdAt: "desc" } });
  if (existing && existing.gateway === gateway && existing.gatewayRef && existing.chargedAmountMinor === chargedAmountMinor) {
    return toSession(existing);
  }
  if (existing) {
    // Stale session (gateway/amount no longer matches) — retire it first.
    await prisma.payment.update({ where: { id: existing.id }, data: { status: "failed", failureReason: "Superseded by a new payment session" } });
  }

  let gatewayRef: string;
  try {
    gatewayRef = useRazorpay
      ? (await createRazorpayOrder(chargedAmountMinor, order.currency, order.id)).id
      : (await createPaymentIntent(chargedAmountMinor, order.currency, { orderId: order.id })).id;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`createPaymentSession(${orderId}): gateway error`, err);
    // The order and its reservation stand; the client can retry this call.
    throw ApiError.badGateway("We couldn't start the payment. Please try again.", { orderId: order.id, retryable: true });
  }

  try {
    const payment = await prisma.payment.create({
      data: {
        orderId,
        customerId: order.customerId,
        amountPaise,
        chargedAmountMinor,
        chargedCurrency: order.currency,
        method: "card",
        gateway,
        gatewayRef,
      },
    });
    await recordOrderEvent(prisma, {
      orderId,
      type: "payment_initiated",
      message: `Payment started via ${gateway === "razorpay" ? "Razorpay" : "Stripe"}`,
      actor: "customer",
      actorUserId: order.customerId,
      metadata: { paymentId: payment.id, gatewayRef },
    });
    return toSession(payment);
  } catch (err) {
    // A concurrent call created the active payment first (partial unique
    // index on Payment(orderId) WHERE status IN (pending, paid)) — use it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.payment.findFirst({ where: { orderId, status: "pending" } });
      if (winner?.gatewayRef) return toSession(winner);
    }
    throw err;
  }
}
