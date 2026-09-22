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
        { variant: { product: { name: { contains: search, mode: "insensitive" } } } },
      ];
    }

    const { skip, take } = toSkipTake({ page, pageSize });
    const [rows, total] = await Promise.all([
      prisma.garmentUnit.findMany({
        where,
        include: {
          variant: {
            select: {
              id: true,
              color: true,
              product: { select: { id: true, name: true, brand: true, category: { select: { name: true } } } },
            },
          },
          currentOrder: { select: { id: true, customer: { select: { name: true } } } },
        },
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
          productId: u.variant.product.id,
          variantId: u.variantId,
          name: u.variant.product.name,
          brand: u.variant.product.brand,
          category: u.variant.product.category.name,
          color: u.variant.color,
          size: u.size,
          stage: u.stage,
          condition: u.condition,
          lastMovedAt: u.lastMovedAt,
          timesRented: u.timesRented,
          currentOrderId: u.currentOrderId,
          currentCustomerName: u.currentOrder?.customer?.name ?? null,
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
        variant: { include: { product: { include: { category: true } } } },
        currentOrder: { select: { id: true, status: true, customer: { select: { name: true } } } },
        stageTransitions: { orderBy: { occurredAt: "desc" }, take: 20 },
      },
    });
    if (!unit) throw ApiError.notFound("Garment unit not found");

    // Flattened the same way as the list endpoint above (variant.product ->
    // top-level productId/name/brand/category/color) so the admin panel's
    // detail view and list view share one adapter shape.
    res.json({
      id: unit.id,
      sku: unit.sku,
      productId: unit.variant.product.id,
      variantId: unit.variantId,
      name: unit.variant.product.name,
      brand: unit.variant.product.brand,
      category: unit.variant.product.category.name,
      color: unit.variant.color,
      size: unit.size,
      stage: unit.stage,
      condition: unit.condition,
      lastMovedAt: unit.lastMovedAt,
      timesRented: unit.timesRented,
      currentOrderId: unit.currentOrderId,
      currentOrder: unit.currentOrder,
      facilityId: unit.facilityId,
      stageTransitions: unit.stageTransitions,
    });
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
