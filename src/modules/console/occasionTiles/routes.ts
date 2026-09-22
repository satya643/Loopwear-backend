import { Router } from "express";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody } from "../../../middleware/validate";
import { upsertOccasionTileSchema } from "./schemas";
import * as occasionTilesService from "./service";

export const consoleOccasionTilesRouter = Router();
consoleOccasionTilesRouter.use(requireAuth, requireRole("operator", "admin"));

// One row per Occasion enum value (Wedding, Party, ...) — the cover image +
// blurb shown on the shop's "Shop by Occasion" home tiles. The shop reads
// these via catalog/service.ts's getOccasionsWithCounts, not from here
// directly — this router is the admin-only write/list side.
consoleOccasionTilesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ items: await occasionTilesService.listOccasionTiles() });
  })
);

consoleOccasionTilesRouter.patch(
  "/:occasion",
  validateBody(upsertOccasionTileSchema),
  asyncHandler(async (req, res) => {
    res.json(await occasionTilesService.upsertOccasionTile(req.params.occasion, req.body));
  })
);

// Reverts an occasion back to unset (no image) — the shop then hides that
// tile entirely rather than showing anything in its place.
consoleOccasionTilesRouter.delete(
  "/:occasion",
  asyncHandler(async (req, res) => {
    await occasionTilesService.deleteOccasionTile(req.params.occasion);
    res.status(204).end();
  })
);
