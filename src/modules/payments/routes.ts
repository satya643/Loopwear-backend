import { Router } from "express";
import express from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { ApiError } from "../../lib/errors";
import { constructWebhookEvent } from "./stripe";
import { createPaymentSession } from "./session";
import * as paymentsService from "./service";
import { handleRazorpayWebhook } from "../webhooks/razorpay";

export const paymentsRouter = Router();
paymentsRouter.use(requireAuth);

const orderIdSchema = z.object({ orderId: z.string().trim().min(1).max(64) });

/** Opens (or re-opens, for a retry) the payment widget for an unpaid order. */
paymentsRouter.post(
  "/razorpay/order",
  validateBody(orderIdSchema),
  asyncHandler(async (req, res) => {
    res.json(await createPaymentSession(req.body.orderId, req.auth!.userId));
  })
);

const razorpayVerifySchema = z.object({
  razorpay_order_id: z.string().min(1).max(64),
  razorpay_payment_id: z.string().min(1).max(64),
  razorpay_signature: z.string().min(1).max(256),
});

/**
 * Called from Razorpay Checkout's success handler. 200 once the order is
 * confirmed; 202 `processing` if Razorpay couldn't be reached to double-check
 * (the webhook/reconcile job finishes it — the client polls the order).
 */
paymentsRouter.post(
  "/razorpay/verify",
  validateBody(razorpayVerifySchema),
  asyncHandler(async (req, res) => {
    const outcome = await paymentsService.verifyRazorpayCheckout(req.auth!.userId, req.body);
    const orderId = outcome.status === "processing" ? outcome.orderId : outcome.result.orderId;
    const orderStatus = outcome.status === "processing" ? "pending_payment" : outcome.result.orderStatus;
    res.status(outcome.status === "processing" ? 202 : 200).json({
      status: outcome.status,
      order: { id: orderId, status: orderStatus },
      // Kept for clients built against the previous response shape.
      payment: { id: outcome.payment.id, orderId, status: outcome.status === "processing" ? outcome.payment.status : "paid" },
    });
  })
);

const failureSchema = orderIdSchema.extend({
  kind: z.enum(["failed", "dismissed"]),
  razorpayPaymentId: z.string().max(64).optional(),
  code: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
  reason: z.string().max(200).optional(),
});

/** Widget reported a failed attempt or was closed. Informational — the order stays payable. */
paymentsRouter.post(
  "/razorpay/failure",
  validateBody(failureSchema),
  asyncHandler(async (req, res) => {
    const { orderId, ...rest } = req.body as z.infer<typeof failureSchema>;
    res.json(await paymentsService.recordPaymentFailure(orderId, req.auth!.userId, { ...rest, actor: "customer" }));
  })
);

const confirmSchema = z.object({ paymentIntentId: z.string().min(1) });

/** Stripe lane (non-INR). */
paymentsRouter.post(
  "/confirm",
  validateBody(confirmSchema),
  asyncHandler(async (req, res) => {
    const payment = await paymentsService.confirmPaymentIntent(req.body.paymentIntentId, req.auth!.userId);
    res.json({ payment });
  })
);

// ---------------------------------------------------------------------------
// Webhooks — need the raw body for signature verification, so these routers
// are mounted in app.ts BEFORE express.json() (once a body parser has run,
// later ones no-op, so the ordering is load-bearing).
// ---------------------------------------------------------------------------

const razorpayWebhook = asyncHandler(async (req, res) => {
  const outcome = await handleRazorpayWebhook(
    req.body as Buffer,
    req.headers["x-razorpay-signature"] as string | undefined,
    req.headers["x-razorpay-event-id"] as string | undefined
  );
  res.json({ received: true, outcome });
});

const stripeWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") throw ApiError.badRequest("Missing stripe-signature header");

  const event = constructWebhookEvent(req.body, signature);
  if (event.type === "payment_intent.succeeded") {
    const intent = event.data.object as { id: string };
    await paymentsService.confirmPaymentIntent(intent.id).catch((err) => {
      if (!(err instanceof ApiError && err.status === 404)) throw err;
    });
  }
  res.json({ received: true });
});

/** Canonical: POST /api/webhooks/razorpay, POST /api/webhooks/stripe */
export const webhooksRouter = Router();
webhooksRouter.post("/razorpay", express.raw({ type: "application/json" }), razorpayWebhook);
webhooksRouter.post("/stripe", express.raw({ type: "application/json" }), stripeWebhook);

/** Legacy paths, kept so gateway dashboards configured with them keep working. */
export const paymentsWebhookRouter = Router();
paymentsWebhookRouter.post("/webhook", express.raw({ type: "application/json" }), stripeWebhook);
paymentsWebhookRouter.post("/razorpay-webhook", express.raw({ type: "application/json" }), razorpayWebhook);
