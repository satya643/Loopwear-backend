import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateQuery } from "../../middleware/validate";
import { listProductsQuerySchema, availabilityQuerySchema } from "./schemas";
import * as catalogService from "./service";
import { getSizeAvailability, getVariantStock } from "../availability/service";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";

export const catalogRouter = Router();

catalogRouter.get(
  "/products",
  validateQuery(listProductsQuerySchema),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ReturnType<(typeof listProductsQuerySchema)["parse"]>;
    const { page, pageSize, ...filters } = q;
    const result = await catalogService.listProducts(filters, { page, pageSize }, {
      currency: req.currency,
      fxRate: req.fxRate,
    });
    res.json(result);
  })
);

catalogRouter.get(
  "/products/:id",
  asyncHandler(async (req, res) => {
    const product = await catalogService.getProductDetail(req.params.id, {
      currency: req.currency,
      fxRate: req.fxRate,
    });
    res.json(product);
  })
);

catalogRouter.get(
  "/products/:id/availability",
  validateQuery(availabilityQuerySchema),
  asyncHandler(async (req, res) => {
    const { size, start, end, variantId } = req.query as unknown as { size: string; start: string; end: string; variantId?: string };
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product || !product.isActive) throw ApiError.notFound("Product not found");

    const startDate = new Date(start);
    const endDate = new Date(end);
    if (variantId) {
      const row = (await getVariantStock(product.id, startDate, endDate)).find((r) => r.variantId === variantId && r.size === size);
      const unitsFree = row?.rentUnitsFree ?? 0;
      res.json({ size, variantId, available: unitsFree > 0, unitsFree });
      return;
    }
    const sizes = await getSizeAvailability(product.id, startDate, endDate);
    const match = sizes.find((s) => s.size === size) ?? { size, available: false, unitsFree: 0 };
    res.json(match);
  })
);

catalogRouter.get(
  "/categories",
  asyncHandler(async (_req, res) => {
    res.json({ items: await catalogService.listCategories() });
  })
);

catalogRouter.get(
  "/occasions",
  asyncHandler(async (_req, res) => {
    const occasions = await catalogService.getOccasionsWithCounts();
    res.json({ items: occasions });
  })
);
