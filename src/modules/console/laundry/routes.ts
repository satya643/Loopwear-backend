import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody, validateQuery } from "../../../middleware/validate";
import { paginationSchema } from "../../../lib/pagination";
import * as laundryService from "./service";

export const laundryRouter = Router();
laundryRouter.use(requireAuth, requireRole("operator", "admin"));

laundryRouter.get(
  "/batches",
  validateQuery(paginationSchema),
  asyncHandler(async (req, res) => {
    const pagination = req.query as unknown as ReturnType<(typeof paginationSchema)["parse"]>;
    res.json(await laundryService.listBatches(pagination));
  })
);

const createBatchSchema = z.object({
  facilityId: z.string().min(1),
  garmentUnitIds: z.array(z.string().min(1)).min(1),
  priority: z.enum(["standard", "rush"]).default("standard"),
});

laundryRouter.post(
  "/batches",
  validateBody(createBatchSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await laundryService.createBatch(req.body));
  })
);

laundryRouter.post(
  "/batches/:id/advance",
  asyncHandler(async (req, res) => {
    res.json(await laundryService.advanceBatch(req.params.id, req.auth!.userId));
  })
);
