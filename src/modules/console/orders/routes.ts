import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody, validateQuery } from "../../../middleware/validate";
import { paginationSchema } from "../../../lib/pagination";
import * as consoleOrdersService from "./service";

export const consoleOrdersRouter = Router();
consoleOrdersRouter.use(requireAuth, requireRole("operator", "admin"));

const listQuerySchema = paginationSchema.extend({
  status: z.string().optional(),
  q: z.string().optional(),
});

consoleOrdersRouter.get(
  "/",
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize, ...filters } = req.query as unknown as ReturnType<(typeof listQuerySchema)["parse"]>;
    res.json(await consoleOrdersService.listOrders(filters, { page, pageSize }));
  })
);

consoleOrdersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await consoleOrdersService.getOrder(req.params.id));
  })
);

const statusSchema = z.object({
  status: z.enum([
    "pending_payment",
    "confirmed",
    "packed",
    "shipped",
    "with_customer",
    "return_in_transit",
    "closed",
    "cancelled",
  ]),
});

consoleOrdersRouter.patch(
  "/:id/status",
  validateBody(statusSchema),
  asyncHandler(async (req, res) => {
    res.json(await consoleOrdersService.setOrderStatus(req.params.id, req.body.status, req.auth!.userId));
  })
);
