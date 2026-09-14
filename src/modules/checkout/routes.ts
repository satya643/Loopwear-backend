import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { ApiError } from "../../lib/errors";
import * as checkoutService from "./service";

export const checkoutRouter = Router();
checkoutRouter.use(requireAuth);

const checkoutSchema = z.object({
  eventDate: z.string().optional(),
  city: z.string().optional(),
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
