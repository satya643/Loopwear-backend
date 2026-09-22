import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody, validateQuery } from "../../../middleware/validate";
import { paginationSchema } from "../../../lib/pagination";
import { ApiError } from "../../../lib/errors";
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

const createJobSchema = z.object({
  orderId: z.string().min(1),
  type: z.enum(["pickup", "dropoff"]),
  windowStart: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "invalid windowStart"),
  windowEnd: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "invalid windowEnd"),
  zone: z.string().min(1),
});

consoleDeliveryRouter.post(
  "/",
  validateBody(createJobSchema),
  asyncHandler(async (req, res) => {
    const { orderId, type, windowStart, windowEnd, zone } = req.body;
    const start = new Date(windowStart);
    const end = new Date(windowEnd);
    if (end <= start) throw ApiError.badRequest("windowEnd must be after windowStart");

    const job = await deliveryService.createDeliveryJob({ orderId, type, windowStart: start, windowEnd: end, zone });
    res.status(201).json(job);
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
