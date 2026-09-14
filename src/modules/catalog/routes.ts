import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateQuery } from "../../middleware/validate";
import { listProductsQuerySchema, availabilityQuerySchema } from "./schemas";
import * as catalogService from "./service";
import { getSizeAvailability } from "../availability/service";
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
    const { size, start, end } = req.query as unknown as { size: string; start: string; end: string };
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) throw ApiError.notFound("Product not found");

    const startDate = new Date(start);
    const endDate = new Date(end);
    const sizes = await getSizeAvailability(product.id, startDate, endDate);
    const match = sizes.find((s) => s.size === size) ?? { size, available: false, unitsFree: 0 };
    res.json(match);
  })
);

catalogRouter.get(
  "/occasions",
  asyncHandler(async (_req, res) => {
    const occasions = await catalogService.getOccasionsWithCounts();
    res.json({ items: occasions });
  })
);
