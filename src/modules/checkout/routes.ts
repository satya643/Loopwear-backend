import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { ApiError } from "../../lib/errors";
import * as checkoutService from "./service";

export const checkoutRouter = Router();
checkoutRouter.use(requireAuth);

// Matches the frontend's DeliveryDetails shape exactly (lib/shop/types.ts) —
// previously the schema only accepted top-level eventDate/city, so zod
// silently stripped the entire `delivery` object the frontend actually sends.
const deliverySchema = z.object({
  fullName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  addressLine1: z.string().min(1),
  addressLine2: z.string().optional(),
  city: z.string().min(1),
  state: z.string().min(1),
  postalCode: z.string().min(1),
  country: z.string().min(1),
  deliveryNote: z.string().optional(),
});

const checkoutSchema = z.object({
  eventDate: z.string().optional(),
  city: z.string().optional(),
  delivery: deliverySchema.optional(),
});

checkoutRouter.post(
  "/",
  validateBody(checkoutSchema),
  asyncHandler(async (req, res) => {
    const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? req.body.idempotencyKey;
    if (!idempotencyKey) throw ApiError.badRequest("Idempotency-Key header is required");

    const result = await checkoutService.checkout(
      req.auth!.userId,
      { ...req.body, idempotencyKey },
      { currency: req.currency, fxRate: req.fxRate }
    );
    res.status(201).json(result);
  })
);
