import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateQuery } from "../../middleware/validate";
import { ApiError } from "../../lib/errors";
import { getOwnedAddress } from "../addresses/service";
import { evaluateCart } from "../cart/service";
import { listDeliveryOptions, serializeDeliveryOption } from "./methods";

export const shippingRouter = Router();

const methodsQuerySchema = z
  .object({
    addressId: z.string().min(1).optional(),
    postalCode: z.string().trim().optional(),
    country: z.string().trim().toUpperCase().default("IN"),
  })
  .refine((q) => q.addressId || q.postalCode, "Pass addressId or postalCode");

/**
 * Delivery options for a saved address (signed in) or a bare PIN code
 * (e.g. a PDP "check delivery" box). Fees reflect the signed-in customer's
 * current cart, since free-delivery thresholds depend on it.
 */
shippingRouter.get(
  "/methods",
  validateQuery(methodsQuerySchema),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof methodsQuerySchema>;
    let dest = { country: q.country, postalCode: q.postalCode ?? "" };
    if (q.addressId) {
      if (!req.auth) throw ApiError.unauthorized();
      const address = await getOwnedAddress(req.auth.userId, q.addressId);
      dest = { country: address.country, postalCode: address.postalCode };
    }
    const subtotalAfterDiscount = req.auth
      ? await evaluateCart(req.auth.userId).then((ev) => ev.quote.subtotalPaise - ev.quote.discountPaise)
      : 0;
    const ctx = { currency: req.currency, fxRate: req.fxRate };
    res.json({ items: listDeliveryOptions(dest, subtotalAfterDiscount).map((o) => serializeDeliveryOption(o, ctx)) });
  })
);
