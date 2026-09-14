import { Router } from "express";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody, validateQuery } from "../../../middleware/validate";
import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";
import { paginatedResponse, toSkipTake } from "../../../lib/pagination";
import { listUnitsQuerySchema, transitionSchema } from "./schemas";
import { transitionGarmentUnit, getLifecycleCounts } from "../lifecycle/stateMachine";

export const inventoryRouter = Router();
inventoryRouter.use(requireAuth, requireRole("operator", "admin"));

inventoryRouter.get(
  "/garment-units",
  validateQuery(listUnitsQuerySchema),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ReturnType<(typeof listUnitsQuerySchema)["parse"]>;
    const { page, pageSize, stage, q: search } = q;

    const where: import("@prisma/client").Prisma.GarmentUnitWhereInput = {};
    if (stage) where.stage = stage as never;
    if (search) {
      where.OR = [
        { sku: { contains: search, mode: "insensitive" } },
        { product: { name: { contains: search, mode: "insensitive" } } },
      ];
    }

    const { skip, take } = toSkipTake({ page, pageSize });
    const [rows, total] = await Promise.all([
      prisma.garmentUnit.findMany({
        where,
        include: { product: { select: { id: true, name: true, brand: true } }, currentOrder: { select: { id: true } } },
        orderBy: { lastMovedAt: "desc" },
        skip,
        take,
      }),
      prisma.garmentUnit.count({ where }),
    ]);

    res.json(
      paginatedResponse(
        rows.map((u) => ({
          id: u.id,
          sku: u.sku,
          product: u.product,
          size: u.size,
          stage: u.stage,
          condition: u.condition,
          lastMovedAt: u.lastMovedAt,
          timesRented: u.timesRented,
          currentOrderId: u.currentOrderId,
          facilityId: u.facilityId,
        })),
        total,
        { page, pageSize }
      )
    );
  })
);

inventoryRouter.get(
  "/garment-units/:id",
  asyncHandler(async (req, res) => {
    const unit = await prisma.garmentUnit.findUnique({
      where: { id: req.params.id },
      include: {
        product: true,
        currentOrder: { select: { id: true, status: true, customer: { select: { name: true } } } },
        stageTransitions: { orderBy: { occurredAt: "desc" }, take: 20 },
      },
    });
    if (!unit) throw ApiError.notFound("Garment unit not found");
    res.json(unit);
  })
);

inventoryRouter.post(
  "/garment-units/:id/transition",
  validateBody(transitionSchema),
  asyncHandler(async (req, res) => {
    const updated = await transitionGarmentUnit(req.params.id, {
      ...req.body,
      actorUserId: req.auth!.userId,
    });
    res.json(updated);
  })
);

inventoryRouter.get(
  "/lifecycle/counts",
  asyncHandler(async (_req, res) => {
    res.json(await getLifecycleCounts());
  })
);
