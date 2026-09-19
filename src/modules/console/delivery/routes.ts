import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody, validateQuery } from "../../../middleware/validate";
import { paginationSchema } from "../../../lib/pagination";
import * as deliveryService from "./service";

export const consoleDeliveryRouter = Router();
consoleDeliveryRouter.use(requireAuth, requireRole("operator", "admin"));

const listQuerySchema = paginationSchema.extend({
  status: z.enum(["scheduled", "en_route", "completed", "delayed"]).optional(),
  type: z.enum(["pickup", "dropoff"]).optional(),
});

consoleDeliveryRouter.get(
  "/",
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize, status, type } = req.query as unknown as ReturnType<(typeof listQuerySchema)["parse"]>;
    res.json(await deliveryService.listDeliveryJobs({ status, type }, { page, pageSize }));
  })
);

consoleDeliveryRouter.patch(
  "/:id/courier",
  validateBody(z.object({ courierId: z.string().min(1) })),
  asyncHandler(async (req, res) => {
    res.json(await deliveryService.reassignCourier(req.params.id, req.body.courierId));
  })
);

consoleDeliveryRouter.patch(
  "/:id/complete",
  asyncHandler(async (req, res) => {
    res.json(await deliveryService.markComplete(req.params.id));
  })
);
