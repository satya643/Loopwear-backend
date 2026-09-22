import { Router } from "express";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { prisma } from "../../../lib/prisma";

export const consoleFacilitiesRouter = Router();
consoleFacilitiesRouter.use(requireAuth, requireRole("operator", "admin"));

// Read-only — Facility rows are reference data for pickers (garment-unit
// stock, laundry batches, delivery jobs), not something the admin panel
// creates or edits.
consoleFacilitiesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const items = await prisma.facility.findMany({ orderBy: { name: "asc" } });
    res.json({ items });
  })
);
