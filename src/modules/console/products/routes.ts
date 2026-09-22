import { Router } from "express";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody, validateQuery } from "../../../middleware/validate";
import {
  listProductsQuerySchema,
  createProductSchema,
  updateProductSchema,
  addVariantSchema,
  updateVariantSchema,
  addUnitSchema,
} from "./schemas";
import * as productsService from "./service";

export const consoleProductsRouter = Router();
consoleProductsRouter.use(requireAuth, requireRole("operator", "admin"));

consoleProductsRouter.get(
  "/",
  validateQuery(listProductsQuerySchema),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as ReturnType<(typeof listProductsQuerySchema)["parse"]>;
    const { page, pageSize, ...filters } = q;
    res.json(await productsService.listProducts(filters, { page, pageSize }));
  })
);

consoleProductsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await productsService.getProduct(req.params.id));
  })
);

consoleProductsRouter.post(
  "/",
  validateBody(createProductSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await productsService.createProduct(req.body));
  })
);

consoleProductsRouter.patch(
  "/:id",
  validateBody(updateProductSchema),
  asyncHandler(async (req, res) => {
    res.json(await productsService.updateProduct(req.params.id, req.body));
  })
);

consoleProductsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    await productsService.deleteProduct(req.params.id);
    res.status(204).end();
  })
);

consoleProductsRouter.post(
  "/:id/variants",
  validateBody(addVariantSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await productsService.addVariant(req.params.id, req.body));
  })
);

consoleProductsRouter.patch(
  "/:id/variants/:variantId",
  validateBody(updateVariantSchema),
  asyncHandler(async (req, res) => {
    res.json(await productsService.updateVariant(req.params.variantId, req.body));
  })
);

consoleProductsRouter.delete(
  "/:id/variants/:variantId",
  asyncHandler(async (req, res) => {
    await productsService.deleteVariant(req.params.variantId);
    res.status(204).end();
  })
);

consoleProductsRouter.post(
  "/:id/units",
  validateBody(addUnitSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json(await productsService.addUnit(req.params.id, req.body));
  })
);
