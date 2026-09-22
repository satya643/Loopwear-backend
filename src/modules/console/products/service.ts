import { Prisma } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";
import { paginatedResponse, toSkipTake, type Pagination } from "../../../lib/pagination";
import { OCCASION_LABELS } from "../../../lib/enumLabels";

const productWithRelations = Prisma.validator<Prisma.ProductDefaultArgs>()({
  include: {
    category: true,
    variants: {
      include: { sizes: true, _count: { select: { garmentUnits: true } } },
      orderBy: { createdAt: "asc" },
    },
  },
});
type ProductWithRelations = Prisma.ProductGetPayload<typeof productWithRelations>;

function serializeProduct(p: ProductWithRelations) {
  return {
    id: p.id,
    name: p.name,
    brand: p.brand,
    categoryId: p.categoryId,
    category: p.category.name,
    occasions: p.occasions.map((o) => OCCASION_LABELS[o] ?? o),
    styles: p.styles,
    rentPricePaise: p.rentPricePaise,
    rentDays: p.rentDays,
    buyPricePaise: p.buyPricePaise,
    depositPaise: p.depositPaise,
    deliveryDays: p.deliveryDays,
    fabric: p.fabric,
    care: p.care,
    measurements: p.measurements,
    description: p.description,
    coverImageUrl: p.coverImageUrl,
    conditionCopy: p.conditionCopy,
    isActive: p.isActive,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    variants: p.variants.map((v) => ({
      id: v.id,
      color: v.color,
      colorHex: v.colorHex,
      views: v.views,
      imageUrls: v.imageUrls,
      isActive: v.isActive,
      sizes: v.sizes.map((s) => s.size),
      unitCount: v._count.garmentUnits,
    })),
    unitCount: p.variants.reduce((sum, v) => sum + v._count.garmentUnits, 0),
  };
}

export interface ListProductsFilters {
  q?: string;
  categoryId?: string;
  isActive?: "true" | "false";
}

export async function listProducts(filters: ListProductsFilters, pagination: Pagination) {
  const where: Prisma.ProductWhereInput = {};
  if (filters.categoryId) where.categoryId = filters.categoryId;
  if (filters.isActive !== undefined) where.isActive = filters.isActive === "true";
  if (filters.q) {
    where.OR = [
      { name: { contains: filters.q, mode: "insensitive" } },
      { brand: { contains: filters.q, mode: "insensitive" } },
    ];
  }

  const { skip, take } = toSkipTake(pagination);
  const [rows, total] = await Promise.all([
    prisma.product.findMany({ where, orderBy: { createdAt: "desc" }, skip, take, ...productWithRelations }),
    prisma.product.count({ where }),
  ]);
  return paginatedResponse(rows.map(serializeProduct), total, pagination);
}

export async function getProduct(id: string) {
  const product = await prisma.product.findUnique({ where: { id }, ...productWithRelations });
  if (!product) throw ApiError.notFound("Product not found");
  return serializeProduct(product);
}

interface VariantInput {
  color: string;
  colorHex: string;
  views: string[];
  imageUrls: Record<string, string>;
  sizes: string[];
  isActive: boolean;
}

// Product + its initial colors, created together in one call — matches the
// admin's "Create Product" form, which builds the variant list client-side
// ("+ Add Another Color") before a single submit.
export async function createProduct(input: Record<string, unknown> & { categoryId: string; variants: VariantInput[] }) {
  const category = await prisma.category.findUnique({ where: { id: input.categoryId } });
  if (!category) throw ApiError.badRequest(`Unknown categoryId "${input.categoryId}"`);

  const { variants, ...productFields } = input;
  const product = await prisma.product.create({
    data: {
      ...productFields,
      variants: {
        create: variants.map((v) => ({
          color: v.color,
          colorHex: v.colorHex,
          views: v.views as never,
          imageUrls: v.imageUrls,
          isActive: v.isActive,
          sizes: { create: v.sizes.map((size) => ({ size })) },
        })),
      },
    } as never,
    ...productWithRelations,
  });
  return serializeProduct(product);
}

// Scalar product fields only (name, category, pricing, occasions, etc.) —
// colors are managed through addVariant/updateVariant/deleteVariant below,
// never folded into this PATCH, so an edit here can never accidentally
// cascade over a color's real inventory.
export async function updateProduct(id: string, input: Record<string, unknown>) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound("Product not found");

  if (input.categoryId) {
    const category = await prisma.category.findUnique({ where: { id: input.categoryId as string } });
    if (!category) throw ApiError.badRequest(`Unknown categoryId "${input.categoryId}"`);
  }

  const product = await prisma.product.update({ where: { id }, data: input as never, ...productWithRelations });
  return serializeProduct(product);
}

/**
 * A REAL, permanent delete — not the isActive:false soft-hide that used to
 * live here (that's now setProductActive/the admin's Publish-Unpublish
 * toggle; keeping both meant "Delete" didn't actually delete anything,
 * which is its own kind of bug).
 *
 * Only allowed when nothing anywhere references this product: OrderItem,
 * CartItem, WishlistItem and OutfitProduct all have an ON DELETE RESTRICT
 * foreign key back to Product (see prisma/schema.prisma migrations), and
 * GarmentUnit has the same RESTRICT back to ProductVariant — the database
 * itself would refuse the delete if any of those existed, but checking
 * up front lets us say exactly *why* instead of surfacing a raw FK error.
 * Review has ON DELETE CASCADE (schema-level decision already made), so a
 * product with reviews CAN technically be hard-deleted at the DB level —
 * blocked here anyway, since silently erasing real customer reviews isn't
 * a side effect an admin clicking "Delete product" would expect.
 *
 * When every count is zero, `prisma.product.delete` succeeds outright:
 * ProductVariant and VariantSize both cascade from Product in the schema.
 */
export async function deleteProduct(id: string) {
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) throw ApiError.notFound("Product not found");

  const [unitCount, orderItemCount, cartItemCount, wishlistCount, outfitCount, reviewCount] = await Promise.all([
    prisma.garmentUnit.count({ where: { variant: { productId: id } } }),
    prisma.orderItem.count({ where: { productId: id } }),
    prisma.cartItem.count({ where: { productId: id } }),
    prisma.wishlistItem.count({ where: { productId: id } }),
    prisma.outfitProduct.count({ where: { productId: id } }),
    prisma.review.count({ where: { productId: id } }),
  ]);

  const blockers: string[] = [];
  if (unitCount > 0) blockers.push(`${unitCount} physical unit(s)`);
  if (orderItemCount > 0) blockers.push(`${orderItemCount} order item(s)`);
  if (cartItemCount > 0) blockers.push(`${cartItemCount} cart item(s)`);
  if (wishlistCount > 0) blockers.push(`${wishlistCount} wishlist save(s)`);
  if (outfitCount > 0) blockers.push(`${outfitCount} outfit/look reference(s)`);
  if (reviewCount > 0) blockers.push(`${reviewCount} review(s)`);

  if (blockers.length > 0) {
    throw ApiError.conflict(
      `This product can't be permanently deleted — it still has ${blockers.join(", ")}. Unpublish it instead, or remove those first.`,
      { unitCount, orderItemCount, cartItemCount, wishlistCount, outfitCount, reviewCount }
    );
  }

  await prisma.product.delete({ where: { id } });
}

// Mirrors POST /console/products/:id/variants — adds one new color to an
// existing product ("+ Add Another Color" after the product already exists).
export async function addVariant(productId: string, input: VariantInput) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) throw ApiError.notFound("Product not found");

  try {
    return await prisma.productVariant.create({
      data: {
        productId,
        color: input.color,
        colorHex: input.colorHex,
        views: input.views as never,
        imageUrls: input.imageUrls,
        isActive: input.isActive,
        sizes: { create: input.sizes.map((size) => ({ size })) },
      },
      include: { sizes: true },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict(`This product already has a "${input.color}" variant`);
    }
    throw err;
  }
}

// Mirrors PATCH /console/products/:id/variants/:variantId. `sizes`, if
// given, REPLACES the declared size list — it only touches VariantSize
// (catalog metadata), never GarmentUnit, so existing physical units for a
// size that's removed here are left exactly as they are; they just stop
// being offered as choosable going forward.
export async function updateVariant(variantId: string, input: Partial<VariantInput>) {
  const existing = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (!existing) throw ApiError.notFound("Variant not found");

  const { sizes, ...scalarFields } = input;

  return prisma.$transaction(async (tx) => {
    if (sizes) {
      await tx.variantSize.deleteMany({ where: { variantId } });
      await tx.variantSize.createMany({ data: sizes.map((size) => ({ variantId, size })) });
    }
    return tx.productVariant.update({
      where: { id: variantId },
      data: scalarFields as never,
      include: { sizes: true },
    });
  });
}

// Mirrors DELETE /console/products/:id/variants/:variantId — blocked while
// any non-retired/sold unit exists for this color, same guard as
// deleteProduct above, at the color level instead of the whole product.
export async function deleteVariant(variantId: string) {
  const existing = await prisma.productVariant.findUnique({ where: { id: variantId } });
  if (!existing) throw ApiError.notFound("Variant not found");

  const activeUnits = await prisma.garmentUnit.count({
    where: { variantId, stage: { notIn: ["retired", "sold"] } },
  });
  if (activeUnits > 0) {
    throw ApiError.conflict(
      "This color still has physical units in circulation — retire or sell them before removing the color",
      { activeUnits }
    );
  }

  await prisma.productVariant.delete({ where: { id: variantId } });
}

// Mirrors POST /console/products/:id/units — adds one physical garment unit
// under a specific (variant, size). The size must already be one of the
// variant's declared sizes (see VariantSize / the admin's size checkboxes).
export async function addUnit(
  productId: string,
  input: { variantId: string; sku: string; size: string; facilityId?: string }
) {
  const variant = await prisma.productVariant.findUnique({
    where: { id: input.variantId },
    include: { sizes: true },
  });
  if (!variant || variant.productId !== productId) throw ApiError.notFound("Variant not found on this product");
  if (!variant.sizes.some((s) => s.size === input.size)) {
    throw ApiError.badRequest(`"${input.size}" is not one of this variant's declared sizes`, {
      declaredSizes: variant.sizes.map((s) => s.size),
    });
  }

  try {
    return await prisma.garmentUnit.create({
      data: { sku: input.sku, size: input.size, variantId: input.variantId, facilityId: input.facilityId },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw ApiError.conflict(`SKU "${input.sku}" is already in use`);
    }
    throw err;
  }
}
