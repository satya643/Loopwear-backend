import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/auth";
import { validateQuery } from "../../middleware/validate";
import { paginationSchema } from "../../lib/pagination";
import * as ordersService from "./service";

export const ordersRouter = Router();
ordersRouter.use(requireAuth);

function ctx(req: import("express").Request) {
  return { currency: req.currency, fxRate: req.fxRate };
}

ordersRouter.get(
  "/",
  validateQuery(paginationSchema),
  asyncHandler(async (req, res) => {
    const pagination = req.query as unknown as ReturnType<(typeof paginationSchema)["parse"]>;
    res.json(await ordersService.listMyOrders(req.auth!.userId, pagination, ctx(req)));
  })
);

ordersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await ordersService.getMyOrder(req.auth!.userId, req.params.id, ctx(req)));
  })
);

ordersRouter.post(
  "/:id/cancel",
  asyncHandler(async (req, res) => {
    await ordersService.cancelMyOrder(req.auth!.userId, req.params.id);
    res.status(204).end();
  })
);
