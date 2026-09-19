import { Router } from "express";
import express from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { ApiError } from "../../lib/errors";
import { constructWebhookEvent } from "./stripe";
import { verifyWebhookSignature } from "./razorpay";
import * as paymentsService from "./service";

export const paymentsRouter = Router();

const confirmSchema = z.object({ paymentIntentId: z.string().min(1) });

paymentsRouter.post(
  "/confirm",
  requireAuth,
  validateBody(confirmSchema),
  asyncHandler(async (req, res) => {
    const payment = await paymentsService.confirmPaymentIntent(req.body.paymentIntentId, req.auth!.userId);
    res.json({ payment });
  })
);

const razorpayVerifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

/**
 * Called by the frontend's Razorpay Checkout `handler` callback once the
 * customer completes payment in the widget. The signature is what proves
 * this really came from Razorpay rather than a client claiming success.
 */
paymentsRouter.post(
  "/razorpay/verify",
  requireAuth,
  validateBody(razorpayVerifySchema),
  asyncHandler(async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const payment = await paymentsService.confirmRazorpayPayment(
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    );
    res.json({ payment });
  })
);

/**
 * Stripe requires the raw request body to verify the webhook signature, so
 * this route is mounted separately in app.ts, BEFORE the global express.json()
 * parser — once any body-parser has run, later ones no-op (body-parser sets
 * req._body), so ordering here is load-bearing, not cosmetic.
 */
export const paymentsWebhookRouter = Router();

paymentsWebhookRouter.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  asyncHandler(async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (typeof signature !== "string") throw ApiError.badRequest("Missing stripe-signature header");

    const event = constructWebhookEvent(req.body, signature);

    if (event.type === "payment_intent.succeeded") {
      const intent = event.data.object as { id: string };
      await paymentsService.confirmPaymentIntent(intent.id).catch(() => {
        // Already processed or not found locally — webhook retries are expected to be idempotent no-ops.
      });
    }

    res.json({ received: true });
  })
);

/**
 * Razorpay webhook — optional (only fires if a webhook is configured in the
 * Razorpay dashboard with RAZORPAY_WEBHOOK_SECRET set to match). Also needs
 * the raw body for signature verification, so it's mounted alongside the
 * Stripe webhook, before express.json().
 */
paymentsWebhookRouter.post(
  "/razorpay-webhook",
  express.raw({ type: "application/json" }),
  asyncHandler(async (req, res) => {
    const signature = req.headers["x-razorpay-signature"];
    if (typeof signature !== "string") throw ApiError.badRequest("Missing x-razorpay-signature header");
    if (!verifyWebhookSignature(req.body, signature)) throw ApiError.badRequest("Invalid webhook signature");

    const event = JSON.parse(req.body.toString("utf8"));

    if (event.event === "payment.captured") {
      const orderId: string | undefined = event.payload?.payment?.entity?.order_id;
      const paymentId: string | undefined = event.payload?.payment?.entity?.id;
      if (orderId && paymentId) {
        // Webhook delivery is already authenticated by the signature check
        // above (there's no separate checkout signature to re-verify here,
        // unlike the /razorpay/verify path), so mark paid directly.
        await paymentsService.markRazorpayPaymentPaidFromWebhook(orderId, paymentId).catch(() => {
          // Already processed or not found locally — webhook retries are expected to be idempotent no-ops.
        });
      }
    }

    res.json({ received: true });
  })
);
