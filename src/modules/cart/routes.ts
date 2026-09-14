import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { validateBody, validateQuery } from "../../middleware/validate";
import { addCartItemSchema, removeCartItemQuerySchema } from "./schemas";
import * as cartService from "./service";
import { z } from "zod";

export const cartRouter = Router();
cartRouter.use(requireAuth);

function ctx(req: import("express").Request) {
  return { currency: req.currency, fxRate: req.fxRate };
}

cartRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await cartService.getCart(req.auth!.userId, ctx(req)));
  })
);

cartRouter.post(
  "/items",
  validateBody(addCartItemSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await cartService.addCartItem(req.auth!.userId, req.body, ctx(req)));
  })
);

cartRouter.delete(
  "/items/:productId",
  validateQuery(removeCartItemQuerySchema),
  asyncHandler(async (req, res) => {
    const { mode } = req.query as unknown as { mode: "rent" | "buy" };
    await cartService.removeCartItem(req.auth!.userId, req.params.productId, mode);
    res.status(204).end();
  })
);

const mergeSchema = z.object({
  lines: z.array(
    z.object({
      productId: z.string().min(1),
      mode: z.enum(["rent", "buy"]),
      size: z.string().min(1),
      startDate: z.string().optional(),
    })
  ),
});

cartRouter.post(
  "/merge",
  validateBody(mergeSchema),
  asyncHandler(async (req, res) => {
    await cartService.mergeCartLines(req.auth!.userId, req.body.lines);
    res.json(await cartService.getCart(req.auth!.userId, ctx(req)));
  })
);
