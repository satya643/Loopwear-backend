import { Prisma, type Product } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import type { Pagination } from "../../lib/pagination";
import { toSkipTake, paginatedResponse } from "../../lib/pagination";
import type { PricingContext } from "../../lib/pricing";
import { presentPricing } from "../../lib/pricing";
import { OCCASION_LABELS, occasionCodeFromLabel } from "../../lib/enumLabels";
import { getSizeAvailability, defaultRentalWindow } from "../availability/service";

export interface ListProductsFilters {
  occasion?: string;
  q?: string;
  category?: string;
  style?: string;
  size?: string;
  color?: string;
  priceMin?: number;
  priceMax?: number;
}

async function ratingMap(productIds: string[]) {
  if (productIds.length === 0) return new Map<string, { avg: number; count: number }>();
  const rows = await prisma.review.groupBy({
    by: ["productId"],
    where: { productId: { in: productIds } },
    _avg: { rating: true },
    _count: { rating: true },
  });
  const map = new Map<string, { avg: number; count: number }>();
  for (const r of rows) map.set(r.productId, { avg: r._avg.rating ?? 0, count: r._count.rating });
  return map;
}

function baseSerialize(product: Product, ctx: PricingContext, rating?: { avg: number; count: number }) {
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category,
    occasions: product.occasions.map((o) => OCCASION_LABELS[o] ?? o),
    styles: product.styles,
    color: product.color,
    colorHex: product.colorHex,
    fabric: product.fabric,
    care: product.care,
    measurements: product.measurements,
    views: product.views,
    imageUrls: product.imageUrls,
    rentDays: product.rentDays,
    deliveryDays: product.deliveryDays,
    // §2: condition is not a real catalog field — static copy instead of a
    // per-product value that doesn't mean anything at the design level.
    conditionCopy: "Excellent condition, inspected before dispatch",
    rating: rating ? Math.round(rating.avg * 10) / 10 : 0,
    reviewCount: rating?.count ?? 0,
    pricing: presentPricing(
      {
        rentPricePaise: product.rentPricePaise,
        buyPricePaise: product.buyPricePaise,
        depositPaise: product.depositPaise,
      },
      ctx
    ),
  };
}

export async function listProducts(filters: ListProductsFilters, pagination: Pagination, ctx: PricingContext) {
  const where: Prisma.ProductWhereInput = { isActive: true };

  if (filters.occasion) {
    const code = occasionCodeFromLabel(filters.occasion) ?? filters.occasion;
    where.occasions = { has: code as never };
  }
  if (filters.category) where.category = { equals: filters.category, mode: "insensitive" };
  if (filters.style) where.styles = { has: filters.style as never };
  if (filters.color) where.color = { equals: filters.color, mode: "insensitive" };
  if (filters.priceMin !== undefined || filters.priceMax !== undefined) {
    const basePaiseMin =
      filters.priceMin !== undefined ? Math.round((filters.priceMin * 100) / ctx.fxRate) : undefined;
    const basePaiseMax =
      filters.priceMax !== undefined ? Math.round((filters.priceMax * 100) / ctx.fxRate) : undefined;
    where.rentPricePaise = { gte: basePaiseMin, lte: basePaiseMax };
  }
  if (filters.q) {
    const q = filters.q;
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { category: { contains: q, mode: "insensitive" } },
      { color: { contains: q, mode: "insensitive" } },
      { brand: { contains: q, mode: "insensitive" } },
    ];
  }
  if (filters.size) {
    where.garmentUnits = { some: { size: filters.size, stage: { notIn: ["retired", "sold"] } } };
  }

  const { skip, take } = toSkipTake(pagination);
  const [rows, total] = await Promise.all([
    prisma.product.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
    prisma.product.count({ where }),
  ]);

  const ratings = await ratingMap(rows.map((r) => r.id));
  const items = rows.map((p) => baseSerialize(p, ctx, ratings.get(p.id)));
  return paginatedResponse(items, total, pagination);
}

export async function getProductDetail(id: string, ctx: PricingContext) {
  const product = await prisma.product.findUnique({ where: { id } });
  if (!product || !product.isActive) throw ApiError.notFound("Product not found");

  const [ratings, similarRows] = await Promise.all([
    ratingMap([id]),
    prisma.product.findMany({
      where: { category: product.category, isActive: true, id: { not: product.id } },
      take: 8,
    }),
  ]);

  const { start, end } = defaultRentalWindow(product.rentDays);
  const sizes = await getSizeAvailability(id, start, end);
  const similarRatings = await ratingMap(similarRows.map((p) => p.id));

  return {
    ...baseSerialize(product, ctx, ratings.get(id)),
    sizes,
    similar: similarRows.map((p) => baseSerialize(p, ctx, similarRatings.get(p.id))),
  };
}

export async function getOccasionsWithCounts() {
  const counts = await Promise.all(
    Object.entries(OCCASION_LABELS).map(async ([code, label]) => {
      const count = await prisma.product.count({
        where: { isActive: true, occasions: { has: code as never } },
      });
      return { code, label, count };
    })
  );
  return counts;
}
