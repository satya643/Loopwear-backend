import { Router } from "express";
import express from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { ApiError } from "../../lib/errors";
import { constructWebhookEvent } from "./stripe";
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
