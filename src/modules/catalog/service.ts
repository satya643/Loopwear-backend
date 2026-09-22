import { Prisma } from "@prisma/client";
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

const productWithRelations = Prisma.validator<Prisma.ProductDefaultArgs>()({
  include: { category: true, variants: { include: { sizes: true }, orderBy: { createdAt: "asc" } } },
});
type ProductWithRelations = Prisma.ProductGetPayload<typeof productWithRelations>;

/**
 * A Product can now have multiple ProductVariant colors (see
 * prisma/schema.prisma) — the shop frontend doesn't have color-swatch UI
 * yet, so the top-level color/colorHex/views/imageUrls fields below are
 * flattened from the first (default) variant to keep today's response
 * shape working unchanged. The new `variants` array carries the full data
 * for when the frontend adds color selection (see architecture note in the
 * admin build: Phase 4).
 */
function baseSerialize(product: ProductWithRelations, ctx: PricingContext, rating?: { avg: number; count: number }) {
  const defaultVariant = product.variants[0];
  return {
    id: product.id,
    name: product.name,
    brand: product.brand,
    category: product.category.name,
    categoryId: product.categoryId,
    occasions: product.occasions.map((o) => OCCASION_LABELS[o] ?? o),
    styles: product.styles,
    color: defaultVariant?.color ?? "",
    colorHex: defaultVariant?.colorHex ?? "",
    views: defaultVariant?.views ?? [],
    imageUrls: defaultVariant?.imageUrls ?? {},
    // Admin-uploaded fallback thumbnail — cards/cart lines fall back to this
    // when a color has no photo of its own yet (see Product.coverImageUrl).
    coverImageUrl: product.coverImageUrl,
    variants: product.variants.map((v) => ({
      id: v.id,
      color: v.color,
      colorHex: v.colorHex,
      views: v.views,
      imageUrls: v.imageUrls,
      sizes: v.sizes.map((s) => s.size),
    })),
    description: product.description,
    fabric: product.fabric,
    care: product.care,
    measurements: product.measurements,
    rentDays: product.rentDays,
    deliveryDays: product.deliveryDays,
    conditionCopy: product.conditionCopy,
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
  if (filters.category) where.category = { name: { equals: filters.category, mode: "insensitive" } };
  if (filters.style) where.styles = { has: filters.style as never };
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
      { category: { name: { contains: q, mode: "insensitive" } } },
      { variants: { some: { color: { contains: q, mode: "insensitive" } } } },
      { brand: { contains: q, mode: "insensitive" } },
    ];
  }
  // color and size both live on ProductVariant/GarmentUnit now — combined
  // into one `variants.some` so "color=Black&size=M" means an actual Black
  // unit in size M exists, not just a Black variant AND a Medium somewhere.
  if (filters.color || filters.size) {
    where.variants = {
      some: {
        ...(filters.color ? { color: { equals: filters.color, mode: "insensitive" } } : {}),
        ...(filters.size
          ? { garmentUnits: { some: { size: filters.size, stage: { notIn: ["retired", "sold"] } } } }
          : {}),
      },
    };
  }

  const { skip, take } = toSkipTake(pagination);
  const [rows, total] = await Promise.all([
    prisma.product.findMany({ where, skip, take, orderBy: { createdAt: "desc" }, ...productWithRelations }),
    prisma.product.count({ where }),
  ]);

  const ratings = await ratingMap(rows.map((r) => r.id));
  const items = rows.map((p) => baseSerialize(p, ctx, ratings.get(p.id)));
  return paginatedResponse(items, total, pagination);
}

export async function getProductDetail(id: string, ctx: PricingContext) {
  const product = await prisma.product.findUnique({ where: { id }, ...productWithRelations });
  if (!product || !product.isActive) throw ApiError.notFound("Product not found");

  const [ratings, similarRows] = await Promise.all([
    ratingMap([id]),
    prisma.product.findMany({
      where: { categoryId: product.categoryId, isActive: true, id: { not: product.id } },
      take: 8,
      ...productWithRelations,
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

// imageUrl/blurb come from OccasionTile (see console/occasionTiles) — null
// for any occasion the admin hasn't uploaded a tile image for yet. The shop
// home page is expected to skip a tile entirely when imageUrl is null
// rather than fall back to placeholder art (see OccasionShowcase on the
// shop frontend).
export async function getOccasionsWithCounts() {
  const tiles = await prisma.occasionTile.findMany();
  const tileByOccasion = new Map(tiles.map((t) => [t.occasion as string, t]));

  const counts = await Promise.all(
    Object.entries(OCCASION_LABELS).map(async ([code, label]) => {
      const count = await prisma.product.count({
        where: { isActive: true, occasions: { has: code as never } },
      });
      const tile = tileByOccasion.get(code);
      return { code, label, count, imageUrl: tile?.imageUrl ?? null, blurb: tile?.blurb ?? null };
    })
  );
  return counts;
}
