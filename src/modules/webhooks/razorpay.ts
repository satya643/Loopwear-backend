import { createHash } from "crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { captureRazorpayPayment, mapRazorpayMethod, verifyWebhookSignature } from "../payments/razorpay";
import { finalizeOrderPayment } from "../payments/finalize";
import { recordPaymentFailure } from "../payments/service";
import { syncPaymentRefundStatus } from "../payments/refunds";
import { recordOrderEvent } from "../orders/events";
import { notifyOps } from "../notifications/orderNotifications";

interface RazorpayPaymentEntity {
  id: string;
  order_id?: string;
  amount: number;
  currency: string;
  status: string;
  method?: string;
  error_code?: string | null;
  error_description?: string | null;
  error_reason?: string | null;
}

interface RazorpayRefundEntity {
  id: string;
  payment_id: string;
  status: string;
}

interface RazorpayWebhookEvent {
  event: string;
  payload?: {
    payment?: { entity: RazorpayPaymentEntity };
    refund?: { entity: RazorpayRefundEntity };
  };
}

export type WebhookOutcome = "processed" | "ignored" | "duplicate";

/**
 * Razorpay webhook entry point.
 *
 * 1. HMAC-SHA256 of the *raw* body with the webhook secret must match
 *    `x-razorpay-signature` (timing-safe) — otherwise 400, nothing stored.
 * 2. The delivery is recorded in WebhookEvent keyed by (provider,
 *    x-razorpay-event-id). A redelivery of an event we already processed is
 *    acknowledged without doing anything. One that previously failed (or is
 *    still in flight) is processed again — safe, because every handler below
 *    is idempotent on its own (finalizeOrderPayment claims the payment with
 *    a guarded update).
 * 3. Webhooks only move existing payments/orders forward. They never create
 *    an order, so no amount of replaying can duplicate one.
 * A handler error marks the event failed and returns 500 so Razorpay retries.
 */
export async function handleRazorpayWebhook(rawBody: Buffer, signature: string | undefined, eventIdHeader: string | undefined): Promise<WebhookOutcome> {
  if (!signature) throw ApiError.badRequest("Missing x-razorpay-signature header");
  if (!verifyWebhookSignature(rawBody, signature)) throw ApiError.badRequest("Invalid webhook signature");

  let event: RazorpayWebhookEvent;
  try {
    event = JSON.parse(rawBody.toString("utf8"));
  } catch {
    throw ApiError.badRequest("Webhook body is not valid JSON");
  }
  const eventId = eventIdHeader || createHash("sha256").update(rawBody).digest("hex");

  let record;
  try {
    record = await prisma.webhookEvent.create({
      data: { provider: "razorpay", eventId, eventType: event.event, payload: event as unknown as Prisma.InputJsonValue },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const existing = await prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider: "razorpay", eventId } } });
    if (existing.status === "processed" || existing.status === "ignored") return "duplicate";
    record = await prisma.webhookEvent.update({ where: { id: existing.id }, data: { attempts: { increment: 1 } } });
  }

  try {
    const outcome = await dispatch(event);
    await prisma.webhookEvent.update({
      where: { id: record.id },
      data: { status: outcome, processedAt: new Date(), error: null },
    });
    return outcome;
  } catch (err) {
    await prisma.webhookEvent.update({
      where: { id: record.id },
      data: { status: "failed", error: err instanceof Error ? err.message.slice(0, 1000) : String(err) },
    });
    throw err;
  }
}

async function paymentFor(entity: RazorpayPaymentEntity | undefined) {
  if (!entity?.order_id) return null;
  return prisma.payment.findUnique({ where: { gatewayRef: entity.order_id } });
}

async function dispatch(event: RazorpayWebhookEvent): Promise<"processed" | "ignored"> {
  const entity = event.payload?.payment?.entity;

  switch (event.event) {
    case "payment.captured":
    case "order.paid": {
      const payment = await paymentFor(entity);
      if (!payment || !entity || entity.status !== "captured") return "ignored";
      if (Number(entity.amount) !== payment.chargedAmountMinor || entity.currency !== payment.chargedCurrency) {
        await recordOrderEvent(prisma, {
          orderId: payment.orderId,
          type: "note",
          message: "Payment amount didn't match the order — held for review",
          actor: "system",
          metadata: { razorpayPaymentId: entity.id, received: entity.amount, expected: payment.chargedAmountMinor },
        });
        await notifyOps("danger", "Payment amount mismatch", `Razorpay payment ${entity.id} for order ${payment.orderId}: got ${entity.amount} ${entity.currency}, expected ${payment.chargedAmountMinor} ${payment.chargedCurrency}.`, payment.orderId);
        return "ignored";
      }
      await finalizeOrderPayment({ paymentId: payment.id, gatewayPaymentRef: entity.id, method: mapRazorpayMethod(entity.method), source: "webhook" });
      return "processed";
    }

    case "payment.authorized": {
      // Only matters when the account doesn't auto-capture; if it does, a
      // payment.captured event follows and this capture attempt just fails.
      const payment = await paymentFor(entity);
      if (!payment || !entity || payment.status === "paid") return "ignored";
      try {
        const captured = await captureRazorpayPayment(entity.id, Number(entity.amount), entity.currency);
        if (captured.status !== "captured" || Number(captured.amount) !== payment.chargedAmountMinor) return "ignored";
      } catch {
        return "ignored";
      }
      await finalizeOrderPayment({ paymentId: payment.id, gatewayPaymentRef: entity.id, method: mapRazorpayMethod(entity.method), source: "webhook" });
      return "processed";
    }

    case "payment.failed": {
      const payment = await paymentFor(entity);
      if (!payment || !entity) return "ignored";
      await recordPaymentFailure(payment.orderId, null, {
        kind: "failed",
        razorpayPaymentId: entity.id,
        code: entity.error_code ?? undefined,
        description: entity.error_description ?? undefined,
        reason: entity.error_reason ?? undefined,
        actor: "gateway",
      });
      return "processed";
    }

    case "refund.processed":
    case "refund.failed": {
      const refundEntity = event.payload?.refund?.entity;
      if (!refundEntity) return "ignored";
      const refund = await prisma.refund.findFirst({ where: { gatewayRef: refundEntity.id } });
      if (!refund) return "ignored";
      const failed = event.event === "refund.failed";
      await prisma.refund.update({
        where: { id: refund.id },
        data: failed ? { status: "failed" } : { status: "processed", processedAt: refund.processedAt ?? new Date() },
      });
      const orderId = refund.orderId ?? (refund.orderItemId ? (await prisma.orderItem.findUnique({ where: { id: refund.orderItemId } }))?.orderId : null);
      if (failed && orderId) {
        await recordOrderEvent(prisma, { orderId, type: "note", message: "A refund failed at the gateway — our team will retry it", actor: "gateway", metadata: { refundId: refund.id } });
        await notifyOps("danger", "Refund failed", `Razorpay refund ${refundEntity.id} for order ${orderId} failed.`, orderId);
      }
      await syncPaymentRefundStatus(refund.paymentId);
      return "processed";
    }

    default:
      return "ignored";
  }
}
