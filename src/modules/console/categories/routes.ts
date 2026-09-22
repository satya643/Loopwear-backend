import { Router } from "express";
import { Prisma } from "@prisma/client";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody } from "../../../middleware/validate";
import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";
import { createCategorySchema, updateCategorySchema } from "./schemas";

export const consoleCategoriesRouter = Router();
consoleCategoriesRouter.use(requireAuth, requireRole("operator", "admin"));

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

// Single source of truth for categories (build note: "don't maintain admin
// categories and website categories separately") — the admin's category
// dropdown and the shop's category navigation both read this same table via
// this list, never a hardcoded array on either side.
consoleCategoriesRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await prisma.category.findMany({
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
      include: { _count: { select: { products: true } } },
    });
    res.json({
      items: rows.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        isActive: c.isActive,
        sortOrder: c.sortOrder,
        productCount: c._count.products,
      })),
    });
  })
);

consoleCategoriesRouter.post(
  "/",
  validateBody(createCategorySchema),
  asyncHandler(async (req, res) => {
    try {
      const category = await prisma.category.create({
        data: { name: req.body.name, slug: slugify(req.body.name), isActive: req.body.isActive, sortOrder: req.body.sortOrder },
      });
      res.status(201).json(category);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw ApiError.conflict(`A category named "${req.body.name}" already exists`);
      }
      throw err;
    }
  })
);

consoleCategoriesRouter.patch(
  "/:id",
  validateBody(updateCategorySchema),
  asyncHandler(async (req, res) => {
    const data: Record<string, unknown> = { ...req.body };
    if (typeof req.body.name === "string") data.slug = slugify(req.body.name);

    try {
      const category = await prisma.category.update({ where: { id: req.params.id }, data });
      res.json(category);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") throw ApiError.notFound("Category not found");
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw ApiError.conflict(`A category named "${req.body.name}" already exists`);
      }
      throw err;
    }
  })
);

// Hard delete only if nothing uses it — Product.categoryId is required, so
// a category with products can never be removed out from under them; the
// admin has to reassign those products to another category first.
consoleCategoriesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const productCount = await prisma.product.count({ where: { categoryId: req.params.id } });
    if (productCount > 0) {
      throw ApiError.conflict(`${productCount} product(s) still use this category — reassign them first`, { productCount });
    }

    try {
      await prisma.category.delete({ where: { id: req.params.id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025") throw ApiError.notFound("Category not found");
      throw err;
    }
    res.status(204).end();
  })
);
