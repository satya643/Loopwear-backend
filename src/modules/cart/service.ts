import type { Cart, Prisma, PrismaClient, ProductVariant, VariantSize } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { presentPricing, type PricingContext } from "../../lib/pricing";
import { pickImageUrl } from "../../lib/images";
import { BUSINESS_RULES } from "../../config/business";
import { countAvailableUnits, rentalWindow, startOfToday } from "../availability/service";
import { computeQuote, type Quote } from "../pricing/quote";
import { evaluateCouponCode } from "../coupons/service";
import { cartItemWithRelations, currentLinePrices, validateCartItems, type ValidatedLine } from "./validation";
import type { AddCartItemInput, MergeCartLine, UpdateCartItemInput } from "./schemas";

type Client = PrismaClient | Prisma.TransactionClient;
type VariantWithSizes = ProductVariant & { sizes: VariantSize[] };

const { maxQuantityPerLine, maxLines } = BUSINESS_RULES.cart;

async function getOrCreateCart(userId: string, client: Client = prisma) {
  return client.cart.upsert({ where: { userId }, update: {}, create: { userId } });
}

// ---------------------------------------------------------------------------
// Evaluation (shared with checkout, order preview and order placement)
// ---------------------------------------------------------------------------

export interface CartCouponState {
  code: string;
  couponId: string | null;
  applied: boolean;
  message: string | null;
  discountPaise: number;
}

export interface CartEvaluation {
  cart: Cart;
  lines: ValidatedLine[];
  /** Lines that can be bought right now (not blocked). */
  purchasable: ValidatedLine[];
  coupon: CartCouponState | null;
  /** Items + discount + deposits; delivery is added once a method is chosen. */
  quote: Quote;
}

export async function evaluateCart(userId: string, client: Client = prisma): Promise<CartEvaluation> {
  const cart = await getOrCreateCart(userId, client);
  const items = await client.cartItem.findMany({ where: { cartId: cart.id }, ...cartItemWithRelations, orderBy: { addedAt: "asc" } });
  const lines = await validateCartItems(items, client);
  const purchasable = lines.filter((l) => l.status !== "blocked");
  const quoteLines = purchasable.map((l) => ({
    mode: l.item.mode,
    unitPricePaise: l.unitPricePaise,
    depositPaise: l.depositPaise,
    quantity: l.item.quantity,
  }));
  const itemsOnly = computeQuote({ lines: quoteLines });

  let coupon: CartCouponState | null = null;
  if (cart.couponCode) {
    const result = await evaluateCouponCode(cart.couponCode, userId, itemsOnly, client);
    coupon = result.evaluation.ok
      ? { code: cart.couponCode, couponId: result.coupon!.id, applied: true, message: null, discountPaise: result.evaluation.discountPaise }
      : { code: cart.couponCode, couponId: result.coupon?.id ?? null, applied: false, message: result.evaluation.message, discountPaise: 0 };
  }

  const quote = computeQuote({ lines: quoteLines, discountPaise: coupon?.applied ? coupon.discountPaise : 0 });
  return { cart, lines, purchasable, coupon, quote };
}

export function cartBlockers(ev: CartEvaluation): string[] {
  if (ev.lines.length === 0) return ["Your bag is empty"];
  return ev.lines.flatMap((l) => l.issues.filter((i) => i.blocking).map((i) => i.message));
}

function serializeLine(line: ValidatedLine, ctx: PricingContext) {
  const { item } = line;
  const priceChange = line.issues.find((i) => i.code === "price_changed");
  return {
    id: item.id,
    productId: item.productId,
    variantId: item.variantId,
    mode: item.mode,
    size: item.size,
    quantity: item.quantity,
    startDate: item.startDate,
    endDate: item.mode === "rent" ? line.window?.end ?? null : null,
    product: {
      id: item.product.id,
      name: item.product.name,
      brand: item.product.brand,
      rentDays: item.product.rentDays,
      imageUrl: pickImageUrl(item.variant.imageUrls, item.product.coverImageUrl),
    },
    variant: { id: item.variant.id, color: item.variant.color, colorHex: item.variant.colorHex },
    status: line.status,
    issues: line.issues.map(({ code, message, blocking, available }) => ({ code, message, blocking, available })),
    availableQuantity: line.available,
    maxQuantity: Math.max(0, Math.min(maxQuantityPerLine, line.available)),
    pricing: presentPricing(
      {
        unitPricePaise: line.unitPricePaise,
        depositPaise: line.depositPaise,
        lineTotalPaise: line.unitPricePaise * item.quantity,
        lineDepositPaise: line.depositPaise * item.quantity,
        ...(priceChange?.previousUnitPricePaise !== undefined ? { previousUnitPricePaise: priceChange.previousUnitPricePaise } : {}),
      },
      ctx
    ),
  };
}

export function serializeCart(ev: CartEvaluation, ctx: PricingContext) {
  const blockers = cartBlockers(ev);
  return {
    id: ev.cart.id,
    items: ev.lines.map((l) => serializeLine(l, ctx)),
    coupon: ev.coupon
      ? {
          code: ev.coupon.code,
          applied: ev.coupon.applied,
          message: ev.coupon.message,
          pricing: presentPricing({ discountPaise: ev.coupon.discountPaise }, ctx),
        }
      : null,
    summary: presentPricing(
      {
        rentSubtotalPaise: ev.quote.rentSubtotalPaise,
        buySubtotalPaise: ev.quote.buySubtotalPaise,
        subtotalPaise: ev.quote.subtotalPaise,
        discountPaise: ev.quote.discountPaise,
        depositTotalPaise: ev.quote.depositTotalPaise,
        totalPaise: ev.quote.totalPaise,
        grandTotalPaise: ev.quote.grandTotalPaise,
      },
      ctx
    ),
    itemCount: ev.lines.reduce((n, l) => n + l.item.quantity, 0),
    lineCount: ev.lines.length,
    canCheckout: blockers.length === 0,
    blockers,
  };
}

export type CartView = ReturnType<typeof serializeCart>;

export async function getCart(userId: string, ctx: PricingContext): Promise<CartView> {
  return serializeCart(await evaluateCart(userId), ctx);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function loadProductForCart(productId: string) {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    include: { variants: { include: { sizes: true }, orderBy: { createdAt: "asc" } } },
  });
  if (!product || !product.isActive) throw ApiError.notFound("This product is no longer available", "product_unavailable");
  return product;
}

type ProductForCart = Awaited<ReturnType<typeof loadProductForCart>>;

function lineWindow(mode: "rent" | "buy", startDate: Date | null, rentDays: number) {
  if (mode === "rent") return rentalWindow(startDate, rentDays);
  const today = startOfToday();
  return { start: today, end: today };
}

/**
 * The colour a line is for. An explicit variantId must belong to the
 * product, be active and offer the size. Without one (quick-add from a
 * product card) the first active colour offering the size that has stock
 * wins, else the first offering it at all (the stock check then reports
 * out of stock).
 */
async function resolveVariant(
  product: ProductForCart,
  req: { variantId?: string; size: string; mode: "rent" | "buy"; window: { start: Date; end: Date } }
): Promise<VariantWithSizes> {
  const offersSize = (v: VariantWithSizes) => v.sizes.some((s) => s.size === req.size);

  if (req.variantId) {
    const variant = product.variants.find((v) => v.id === req.variantId);
    if (!variant || !variant.isActive) {
      throw ApiError.conflict(`This colour of ${product.name} is no longer available`, { variantId: req.variantId }, "variant_unavailable");
    }
    if (!offersSize(variant)) {
      throw ApiError.conflict(`${product.name} in ${variant.color} isn't offered in size ${req.size}`, { variantId: variant.id, size: req.size }, "variant_unavailable");
    }
    return variant;
  }

  const candidates = product.variants.filter((v) => v.isActive && offersSize(v));
  if (candidates.length === 0) {
    throw ApiError.conflict(`${product.name} isn't offered in size ${req.size}`, { size: req.size }, "variant_unavailable");
  }
  for (const variant of candidates) {
    const available = await countAvailableUnits(prisma, { variantId: variant.id, size: req.size, mode: req.mode, ...req.window });
    if (available > 0) return variant;
  }
  return candidates[0];
}

function assertStock(productName: string, size: string, requested: number, available: number, inCart = 0) {
  if (available === 0) {
    throw ApiError.conflict(`${productName} (${size}) is out of stock`, { available: 0, inCart }, "out_of_stock");
  }
  if (requested > available) {
    const already = inCart > 0 ? ` (you already have ${inCart} in your bag)` : "";
    throw ApiError.conflict(`Only ${available} of ${productName} (${size}) available${already}`, { available, inCart }, "out_of_stock");
  }
}

export async function addCartItem(userId: string, input: AddCartItemInput, ctx: PricingContext): Promise<CartView> {
  const product = await loadProductForCart(input.productId);
  const requestedStart = input.mode === "rent" && input.startDate ? new Date(input.startDate) : null;
  const window = lineWindow(input.mode, requestedStart, product.rentDays);
  const variant = await resolveVariant(product, { variantId: input.variantId, size: input.size, mode: input.mode, window });

  const cart = await getOrCreateCart(userId);
  const existing = await prisma.cartItem.findUnique({
    where: { cartId_variantId_size_mode: { cartId: cart.id, variantId: variant.id, size: input.size, mode: input.mode } },
  });
  if (!existing && (await prisma.cartItem.count({ where: { cartId: cart.id } })) >= maxLines) {
    throw ApiError.conflict(`Your bag can hold at most ${maxLines} different items`, undefined, "quantity_limit");
  }

  const quantity = (existing?.quantity ?? 0) + input.quantity;
  if (quantity > maxQuantityPerLine) {
    throw ApiError.conflict(`You can add at most ${maxQuantityPerLine} of an item`, { max: maxQuantityPerLine, inCart: existing?.quantity ?? 0 }, "quantity_limit");
  }

  // A re-add of an existing rental keeps its date unless a new one is given.
  const startDate = input.mode === "rent" ? requestedStart ?? existing?.startDate ?? null : null;
  const finalWindow = lineWindow(input.mode, startDate, product.rentDays);
  const available = await countAvailableUnits(prisma, { variantId: variant.id, size: input.size, mode: input.mode, ...finalWindow });
  assertStock(product.name, input.size, quantity, available, existing?.quantity ?? 0);

  // Prices come from the product row, never the request. The snapshot is
  // only what the customer saw, for "price changed" notices later.
  const { unitPricePaise, depositPaise } = currentLinePrices({ mode: input.mode, product });
  await prisma.cartItem.upsert({
    where: { cartId_variantId_size_mode: { cartId: cart.id, variantId: variant.id, size: input.size, mode: input.mode } },
    update: { quantity, startDate, unitPricePaiseSnapshot: unitPricePaise, depositPaiseSnapshot: depositPaise },
    create: {
      cartId: cart.id,
      productId: product.id,
      variantId: variant.id,
      mode: input.mode,
      size: input.size,
      quantity,
      startDate,
      unitPricePaiseSnapshot: unitPricePaise,
      depositPaiseSnapshot: depositPaise,
    },
  });
  return getCart(userId, ctx);
}

export async function updateCartItem(userId: string, itemId: string, input: UpdateCartItemInput, ctx: PricingContext): Promise<CartView> {
  const item = await prisma.cartItem.findFirst({ where: { id: itemId, cart: { userId } }, ...cartItemWithRelations });
  if (!item) throw ApiError.notFound("This item is no longer in your bag");

  const [line] = await validateCartItems([item]);
  const structural = line.issues.find(
    (i): i is typeof i & { code: "product_unavailable" | "variant_unavailable" } =>
      i.code === "product_unavailable" || i.code === "variant_unavailable"
  );
  if (structural) throw ApiError.conflict(`${structural.message} — remove it from your bag`, undefined, structural.code);

  const quantity = input.quantity ?? item.quantity;
  const startDate =
    item.mode !== "rent" ? null : input.startDate === undefined ? item.startDate : input.startDate ? new Date(input.startDate) : null;
  const window = lineWindow(item.mode, startDate, item.product.rentDays);
  const available = await countAvailableUnits(prisma, { variantId: item.variantId, size: item.size, mode: item.mode, ...window });
  assertStock(item.product.name, item.size, quantity, available);

  await prisma.cartItem.update({ where: { id: item.id }, data: { quantity, startDate } });
  return getCart(userId, ctx);
}

/**
 * Removes by cart-item id. `?mode=` keeps the pre-variant contract working
 * (DELETE /cart/items/:productId?mode=rent removed every line of that
 * product+mode) for clients that haven't moved to item ids yet.
 */
export async function removeCartItem(userId: string, idOrProductId: string, legacyMode?: "rent" | "buy") {
  await prisma.cartItem.deleteMany({
    where: {
      cart: { userId },
      OR: [{ id: idOrProductId }, ...(legacyMode ? [{ productId: idOrProductId, mode: legacyMode }] : [])],
    },
  });
}

export async function applyCoupon(userId: string, code: string, ctx: PricingContext): Promise<CartView> {
  const ev = await evaluateCart(userId);
  if (ev.purchasable.length === 0) {
    throw ApiError.conflict("Add items to your bag before applying a coupon", undefined, "coupon_invalid");
  }
  const result = await evaluateCouponCode(code, userId, ev.quote);
  if (!result.evaluation.ok) {
    throw ApiError.conflict(result.evaluation.message, { reason: result.evaluation.reason }, "coupon_invalid");
  }
  await prisma.cart.update({ where: { id: ev.cart.id }, data: { couponCode: result.coupon!.code } });
  return getCart(userId, ctx);
}

export async function removeCoupon(userId: string, ctx: PricingContext): Promise<CartView> {
  await prisma.cart.updateMany({ where: { userId }, data: { couponCode: null } });
  return getCart(userId, ctx);
}

/**
 * Run when the customer enters checkout: reports every price that moved
 * since they added the item, then refreshes the snapshots so the notice is
 * shown once. The real guard against paying a surprise amount is the
 * `expectedTotalPaise` check at order placement.
 */
export async function revalidateCart(userId: string, ctx: PricingContext) {
  const ev = await evaluateCart(userId);
  const priceChanges = ev.lines.flatMap((l) =>
    l.issues
      .filter((i) => i.code === "price_changed")
      .map((i) => ({
        itemId: l.item.id,
        productName: l.item.product.name,
        message: i.message,
        pricing: presentPricing({ previousUnitPricePaise: i.previousUnitPricePaise!, currentUnitPricePaise: i.currentUnitPricePaise! }, ctx),
      }))
  );
  const stale = ev.lines.filter(
    (l) => l.item.product.isActive && (l.item.unitPricePaiseSnapshot !== l.unitPricePaise || l.item.depositPaiseSnapshot !== l.depositPaise)
  );
  if (stale.length > 0) {
    await prisma.$transaction(
      stale.map((l) =>
        prisma.cartItem.update({
          where: { id: l.item.id },
          data: { unitPricePaiseSnapshot: l.unitPricePaise, depositPaiseSnapshot: l.depositPaise },
        })
      )
    );
  }
  return { ...(await getCart(userId, ctx)), priceChanges };
}

/**
 * Folds a guest's localStorage bag into their account cart after sign-in.
 * Per line: quantity = max(already in account cart, guest quantity), capped
 * by stock and the per-line limit. Lines that can't be added (unpublished,
 * colour/size gone, out of stock) are reported back instead of failing the
 * whole merge, so the customer is told exactly what didn't make it.
 */
export async function mergeCartLines(userId: string, lines: MergeCartLine[], ctx: PricingContext) {
  const cart = await getOrCreateCart(userId);
  const dropped: { productId: string; size: string; mode: string; reason: string; message: string }[] = [];
  const reduced: { productId: string; size: string; mode: string; quantity: number; message: string }[] = [];
  let merged = 0;
  const today = startOfToday();

  for (const line of lines) {
    try {
      const product = await loadProductForCart(line.productId);
      const parsedStart = line.mode === "rent" && line.startDate ? new Date(line.startDate) : null;
      const startDate = parsedStart && !Number.isNaN(parsedStart.getTime()) && parsedStart >= today ? parsedStart : null;
      const window = lineWindow(line.mode, startDate, product.rentDays);
      const variant = await resolveVariant(product, { variantId: line.variantId, size: line.size, mode: line.mode, window });

      const key = { cartId: cart.id, variantId: variant.id, size: line.size, mode: line.mode };
      const existing = await prisma.cartItem.findUnique({ where: { cartId_variantId_size_mode: key } });
      if (!existing && (await prisma.cartItem.count({ where: { cartId: cart.id } })) >= maxLines) {
        dropped.push({ ...pick(line), reason: "quantity_limit", message: `Your bag is full (${maxLines} items max)` });
        continue;
      }

      const available = await countAvailableUnits(prisma, { variantId: variant.id, size: line.size, mode: line.mode, ...window });
      const wanted = Math.max(existing?.quantity ?? 0, line.quantity);
      const quantity = Math.min(wanted, maxQuantityPerLine, available);
      if (quantity === 0) {
        dropped.push({ ...pick(line), reason: "out_of_stock", message: `${product.name} (${line.size}) is out of stock` });
        continue;
      }
      if (quantity < wanted) {
        reduced.push({ ...pick(line), quantity, message: `Only ${quantity} of ${product.name} (${line.size}) could be added` });
      }

      const { unitPricePaise, depositPaise } = currentLinePrices({ mode: line.mode, product });
      await prisma.cartItem.upsert({
        where: { cartId_variantId_size_mode: key },
        update: { quantity, startDate: startDate ?? existing?.startDate ?? null },
        create: { ...key, productId: product.id, quantity, startDate, unitPricePaiseSnapshot: unitPricePaise, depositPaiseSnapshot: depositPaise },
      });
      merged += 1;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      dropped.push({ ...pick(line), reason: err.code, message: err.message });
    }
  }

  return { ...(await getCart(userId, ctx)), merge: { merged, dropped, reduced } };
}

function pick(line: MergeCartLine) {
  return { productId: line.productId, size: line.size, mode: line.mode };
}
