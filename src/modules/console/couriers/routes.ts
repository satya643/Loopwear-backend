import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody } from "../../../middleware/validate";
import { prisma } from "../../../lib/prisma";

export const consoleCouriersRouter = Router();
consoleCouriersRouter.use(requireAuth, requireRole("operator", "admin"));

consoleCouriersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const items = await prisma.courier.findMany({ orderBy: { name: "asc" } });
    res.json({ items });
  })
);

const createCourierSchema = z.object({
  name: z.string().min(1),
  zones: z.array(z.string().min(1)).default([]),
});

consoleCouriersRouter.post(
  "/",
  validateBody(createCourierSchema),
  asyncHandler(async (req, res) => {
    const courier = await prisma.courier.create({ data: req.body });
    res.status(201).json(courier);
  })
);
