import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody } from "../../../middleware/validate";
import * as laundryService from "./service";

export const laundryRouter = Router();
laundryRouter.use(requireAuth, requireRole("operator", "admin"));

laundryRouter.get(
  "/batches",
  asyncHandler(async (_req, res) => {
    res.json({ items: await laundryService.listBatches() });
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
