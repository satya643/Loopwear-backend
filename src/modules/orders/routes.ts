import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { checkoutRateLimiter } from "../../middleware/rateLimit";
import { validateBody, validateQuery } from "../../middleware/validate";
import { paginationSchema } from "../../lib/pagination";
import { createPaymentSession } from "../payments/session";
import { previewOrder, placeOrder } from "./placement";
import * as ordersService from "./service";

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

function ctx(req: import("express").Request) {
  return { currency: req.currency, fxRate: req.fxRate };
}

const previewSchema = z.object({
  addressId: z.string().trim().min(1).max(64),
  deliveryMethod: z.string().trim().min(1).max(32),
});

const placeSchema = previewSchema.extend({
  // The grand total the customer saw on the review screen (from /preview).
  expectedTotalPaise: z.number().int().nonnegative(),
});

const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/, "Idempotency-Key must be 8-128 characters of [A-Za-z0-9_-]");

ordersRouter.get(
  "/",
  validateQuery(paginationSchema),
  asyncHandler(async (req, res) => {
    const pagination = req.query as unknown as z.infer<typeof paginationSchema>;
    res.json(await ordersService.listMyOrders(req.auth!.userId, pagination));
  })
);

ordersRouter.post(
  "/preview",
  validateBody(previewSchema),
  asyncHandler(async (req, res) => {
    res.json(await previewOrder(req.auth!.userId, req.body, ctx(req)));
  })
);

/**
 * Places the order (stock reserved, awaiting payment) and opens its payment
 * session in one round trip. If the gateway is down the order still stands
 * and `paymentError` says so; the client retries POST /payments/razorpay/order.
 */
ordersRouter.post(
  "/",
  checkoutRateLimiter,
  validateBody(placeSchema),
  asyncHandler(async (req, res) => {
    const parsedKey = idempotencyKeySchema.safeParse(req.headers["idempotency-key"]);
    if (!parsedKey.success) throw ApiError.badRequest("A valid Idempotency-Key header is required");

    const { order, replayed } = await placeOrder(req.auth!.userId, req.body, parsedKey.data, ctx(req));
    let payment = null;
    let paymentError = null;
    if (order.status === "pending_payment") {
      try {
        payment = await createPaymentSession(order.id, req.auth!.userId);
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        paymentError = { code: err.code, message: err.message };
      }
    }
    res.status(replayed ? 200 : 201).json({ order: await ordersService.getMyOrder(req.auth!.userId, order.id), payment, paymentError, replayed });
  })
);

ordersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await ordersService.getMyOrder(req.auth!.userId, req.params.id));
  })
);

ordersRouter.get(
  "/:id/status",
  asyncHandler(async (req, res) => {
    res.json(await ordersService.getMyOrderStatus(req.auth!.userId, req.params.id));
  })
);

ordersRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    await ordersService.cancelOrder(req.params.id, { actor: "customer", actorUserId: req.auth!.userId, ownerUserId: req.auth!.userId });
    res.json(await ordersService.getMyOrder(req.auth!.userId, req.params.id));
  })
);
