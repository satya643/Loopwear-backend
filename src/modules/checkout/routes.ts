import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { checkoutRateLimiter } from "../../middleware/rateLimit";
import { validateBody } from "../../middleware/validate";
import { ApiError } from "../../lib/errors";
import * as checkoutService from "./service";

export const checkoutRouter = Router();
checkoutRouter.use(requireAuth);

function ctx(req: import("express").Request) {
  return { currency: req.currency, fxRate: req.fxRate };
}

/** Checkout gate: 401 for guests, otherwise cart + addresses + delivery options + blockers. */
checkoutRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await checkoutService.getCheckoutSummary(req.auth!.userId, ctx(req)));
  })
);

const legacySchema = z.object({
  delivery: z
    .object({
      fullName: z.string().min(1),
      email: z.string().optional(),
      phone: z.string().min(1),
      addressLine1: z.string().min(1),
      addressLine2: z.string().optional(),
      city: z.string().min(1),
      state: z.string().min(1),
      postalCode: z.string().min(1),
      country: z.string().min(1),
      deliveryNote: z.string().optional(),
    })
    .optional(),
});

/** Deprecated — see checkoutService.legacyCheckout. New clients use POST /orders. */
checkoutRouter.post(
  "/",
  checkoutRateLimiter,
  validateBody(legacySchema),
  asyncHandler(async (req, res) => {
    const idempotencyKey = req.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8) throw ApiError.badRequest("Idempotency-Key header is required");
    res.status(201).json(await checkoutService.legacyCheckout(req.auth!.userId, req.body.delivery, idempotencyKey, ctx(req)));
  })
);
