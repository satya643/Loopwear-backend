import { Router } from "express";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import * as analyticsService from "./service";

export const consoleAnalyticsRouter = Router();
consoleAnalyticsRouter.use(requireAuth, requireRole("operator", "admin"));

consoleAnalyticsRouter.get(
  "/:metric",
  asyncHandler(async (req, res) => {
    res.json(await analyticsService.getMetricSeries(req.params.metric));
  })
);
