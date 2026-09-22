import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { presentPricing, type PricingContext } from "../../lib/pricing";

async function getOrCreateCart(userId: string) {
  return prisma.cart.upsert({
    where: { userId },
    update: {},
    create: { userId },
  });
}

async function serializeCart(cartId: string, ctx: PricingContext) {
  const items = await prisma.cartItem.findMany({
    where: { cartId },
    // The cart doesn't capture which color the customer chose yet (see
    // ProductVariant) — the first variant stands in as the product's
    // representative image, same as today's one-color-per-product display.
    include: { product: { include: { variants: { take: 1, orderBy: { createdAt: "asc" } } } } },
    orderBy: { addedAt: "asc" },
  });
  return {
    items: items.map((item) => ({
      id: item.id,
      productId: item.productId,
      product: {
        id: item.product.id,
        name: item.product.name,
        brand: item.product.brand,
        colorHex: item.product.variants[0]?.colorHex ?? "#172b4d",
        // Falls back to the product's admin-uploaded cover image when its
        // first color has no photo of its own yet (see Product.coverImageUrl).
        imageUrls:
          Object.keys(item.product.variants[0]?.imageUrls ?? {}).length > 0
            ? (item.product.variants[0]!.imageUrls as Record<string, string>)
            : item.product.coverImageUrl
              ? { front: item.product.coverImageUrl }
              : {},
      },
      mode: item.mode,
      size: item.size,
      startDate: item.startDate,
      pricing: presentPricing(
        item.mode === "rent"
          ? { rentPricePaise: item.product.rentPricePaise, depositPaise: item.product.depositPaise }
          : { buyPricePaise: item.product.buyPricePaise },
        ctx
      ),
    })),
  };
}

export async function getCart(userId: string, ctx: PricingContext) {
  const cart = await getOrCreateCart(userId);
  return serializeCart(cart.id, ctx);
}

/**
 * Adding the same (productId, mode) replaces the existing line — mirrors the
 * frontend cart-context's addLine behavior exactly (build spec §3 carts).
 */
export async function addCartItem(
  userId: string,
  input: { productId: string; mode: "rent" | "buy"; size: string; startDate?: string },
  ctx: PricingContext
) {
  const product = await prisma.product.findUnique({ where: { id: input.productId } });
  if (!product || !product.isActive) throw ApiError.notFound("Product not found");

  const cart = await getOrCreateCart(userId);
  await prisma.cartItem.upsert({
    where: { cartId_productId_mode: { cartId: cart.id, productId: input.productId, mode: input.mode } },
    update: { size: input.size, startDate: input.startDate ? new Date(input.startDate) : null },
    create: {
      cartId: cart.id,
      productId: input.productId,
      mode: input.mode,
      size: input.size,
      startDate: input.startDate ? new Date(input.startDate) : null,
    },
  });
  return serializeCart(cart.id, ctx);
}

export async function removeCartItem(userId: string, productId: string, mode: "rent" | "buy") {
  const cart = await prisma.cart.findUnique({ where: { userId } });
  if (!cart) return;
  await prisma.cartItem
    .delete({ where: { cartId_productId_mode: { cartId: cart.id, productId, mode } } })
    .catch(() => {
      // Idempotent delete: already gone is not an error.
    });
}

/**
 * Merges a set of guest/local cart lines into the account cart on login.
 * Dedup rule matches the frontend's own line-replace semantics: last write
 * (the incoming guest line) wins per (productId, mode).
 */
export async function mergeCartLines(
  userId: string,
  lines: Array<{ productId: string; mode: "rent" | "buy"; size: string; startDate?: string }>
) {
  const cart = await getOrCreateCart(userId);
  for (const line of lines) {
    await prisma.cartItem.upsert({
      where: { cartId_productId_mode: { cartId: cart.id, productId: line.productId, mode: line.mode } },
      update: { size: line.size, startDate: line.startDate ? new Date(line.startDate) : null },
      create: {
        cartId: cart.id,
        productId: line.productId,
        mode: line.mode,
        size: line.size,
        startDate: line.startDate ? new Date(line.startDate) : null,
      },
    });
  }
}
