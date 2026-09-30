import { createHash } from "crypto";
import { Prisma, type Address, type Order } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { generateOrderId } from "../../lib/orderId";
import { pickImageUrl } from "../../lib/images";
import { presentPricing, type PricingContext } from "../../lib/pricing";
import { BUSINESS_RULES } from "../../config/business";
import { evaluateCart, serializeCart, cartBlockers, type CartEvaluation } from "../cart/service";
import { assertAddressDeliverable, addressSnapshot, getOwnedAddress, serializeAddress } from "../addresses/service";
import { listDeliveryOptions, resolveDeliveryOption, serializeDeliveryOption, type DeliveryOption } from "../shipping/methods";
import { computeQuote, type Quote } from "../pricing/quote";
import { allocateUnits, reserveUnits, type AllocatedUnit } from "./inventory";
import { closeUnpaidOrder } from "./lifecycle";
import { recordOrderEvent } from "./events";

export interface PlacementInput {
  addressId: string;
  deliveryMethod: string;
}

interface Draft {
  ev: CartEvaluation;
  address: Address;
  delivery: DeliveryOption;
  quote: Quote;
  blockers: string[];
  fingerprint: string;
}

/**
 * The FINAL server-side validation, run by both the review screen (preview)
 * and order placement so they can never disagree: cart exists and isn't
 * empty, every product/variant still exists and is offered, stock covers
 * every quantity, prices are today's, the coupon still applies, the address
 * is the caller's and deliverable, the delivery method is available there —
 * then the amount is recomputed from scratch.
 */
async function buildDraft(userId: string, input: PlacementInput): Promise<Draft> {
  const ev = await evaluateCart(userId);
  if (ev.lines.length === 0) throw ApiError.badRequest("Your bag is empty", undefined, "cart_empty");

  const address = await getOwnedAddress(userId, input.addressId);
  assertAddressDeliverable(address);

  const blockers = cartBlockers(ev);
  if (ev.coupon && !ev.coupon.applied) blockers.push(`${ev.coupon.message} — remove the coupon to continue`);

  const subtotalAfterDiscount = ev.quote.subtotalPaise - ev.quote.discountPaise;
  const delivery = resolveDeliveryOption(input.deliveryMethod, address, subtotalAfterDiscount);
  const quote = computeQuote({
    lines: ev.purchasable.map((l) => ({
      mode: l.item.mode,
      unitPricePaise: l.unitPricePaise,
      depositPaise: l.depositPaise,
      quantity: l.item.quantity,
    })),
    discountPaise: ev.quote.discountPaise,
    deliveryFeePaise: delivery.feePaise,
  });

  return { ev, address, delivery, quote, blockers, fingerprint: fingerprintOf(ev, address, delivery, quote) };
}

/** Same checkout (items, prices, address, method, coupon, total) ⇒ same fingerprint. */
function fingerprintOf(ev: CartEvaluation, address: Address, delivery: DeliveryOption, quote: Quote): string {
  const lines = ev.purchasable
    .map((l) => [l.item.variantId, l.item.size, l.item.mode, l.item.quantity, l.item.startDate?.toISOString() ?? "", l.unitPricePaise, l.depositPaise].join("|"))
    .sort();
  const payload = JSON.stringify({
    lines,
    address: [address.id, address.updatedAt.toISOString()],
    delivery: delivery.code,
    coupon: ev.coupon?.applied ? ev.coupon.code : null,
    total: quote.grandTotalPaise,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function presentQuote(quote: Quote, ctx: PricingContext) {
  return presentPricing(
    {
      rentSubtotalPaise: quote.rentSubtotalPaise,
      buySubtotalPaise: quote.buySubtotalPaise,
      subtotalPaise: quote.subtotalPaise,
      discountPaise: quote.discountPaise,
      deliveryFeePaise: quote.deliveryFeePaise,
      depositTotalPaise: quote.depositTotalPaise,
      totalPaise: quote.totalPaise,
      grandTotalPaise: quote.grandTotalPaise,
    },
    ctx
  );
}

function serializePreview(draft: Draft, ctx: PricingContext) {
  const subtotalAfterDiscount = draft.quote.subtotalPaise - draft.quote.discountPaise;
  return {
    canPlaceOrder: draft.blockers.length === 0,
    blockers: draft.blockers,
    cart: serializeCart(draft.ev, ctx),
    address: serializeAddress(draft.address),
    delivery: serializeDeliveryOption(draft.delivery, ctx),
    deliveryOptions: listDeliveryOptions(draft.address, subtotalAfterDiscount).map((o) => serializeDeliveryOption(o, ctx)),
    pricing: presentQuote(draft.quote, ctx),
    // Echo this back as POST /orders' expectedTotalPaise: if anything moves
    // between review and "Pay", placement refuses instead of charging it.
    expectedTotalPaise: draft.quote.grandTotalPaise,
    holdMinutes: BUSINESS_RULES.checkoutHoldMinutes,
  };
}

export async function previewOrder(userId: string, input: PlacementInput, ctx: PricingContext) {
  return serializePreview(await buildDraft(userId, input), ctx);
}

export interface PlaceOrderResult {
  order: Order;
  /** True when an existing order was returned (same Idempotency-Key or identical checkout). */
  replayed: boolean;
}

/**
 * Creates the order as `pending_payment` with its stock reserved. Does NOT
 * confirm it and does NOT touch the cart — only a verified payment does
 * that (payments/finalize.ts). Safe to retry:
 *  - same Idempotency-Key → the same order;
 *  - identical checkout still awaiting payment → that order (double submit);
 *  - otherwise a new order, which supersedes (releases) the customer's older
 *    unpaid orders so abandoned attempts don't sit on stock.
 * Everything inside the transaction is all-or-nothing: an out-of-stock line
 * or any failure leaves no order, no reservation and the cart unchanged.
 */
export async function placeOrder(
  userId: string,
  input: PlacementInput & { expectedTotalPaise?: number },
  idempotencyKey: string,
  ctx: PricingContext,
  opts: { createdVia?: string } = {}
): Promise<PlaceOrderResult> {
  const prior = await prisma.order.findUnique({ where: { idempotencyKey } });
  if (prior) {
    if (prior.customerId !== userId) throw ApiError.conflict("Idempotency key already used", undefined, "idempotency_conflict");
    return { order: prior, replayed: true };
  }

  const draft = await buildDraft(userId, input);
  if (draft.blockers.length > 0) {
    throw ApiError.conflict("Some items in your bag need attention before you can place this order", {
      blockers: draft.blockers,
      cart: serializeCart(draft.ev, ctx),
    }, "cart_invalid");
  }
  if (input.expectedTotalPaise !== undefined && input.expectedTotalPaise !== draft.quote.grandTotalPaise) {
    throw ApiError.conflict(
      "Your order total has changed. Please review the updated amount before paying.",
      { expectedTotalPaise: input.expectedTotalPaise, currentTotalPaise: draft.quote.grandTotalPaise, preview: serializePreview(draft, ctx) },
      "price_changed"
    );
  }

  const duplicate = await prisma.order.findFirst({
    where: {
      customerId: userId,
      status: "pending_payment",
      checkoutFingerprint: draft.fingerprint,
      // Leave at least a minute to actually pay; otherwise start fresh.
      paymentExpiresAt: { gt: new Date(Date.now() + 60_000) },
    },
    orderBy: { createdAt: "desc" },
  });
  if (duplicate) return { order: duplicate, replayed: true };

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  const orderId = generateOrderId();
  const now = new Date();
  const rentStarts = draft.ev.purchasable.filter((l) => l.item.mode === "rent").map((l) => l.window!.start.getTime());

  try {
    await prisma.$transaction(
      async (tx) => {
        const olderUnpaid = await tx.order.findMany({ where: { customerId: userId, status: "pending_payment" }, select: { id: true } });
        for (const older of olderUnpaid) {
          await closeUnpaidOrder(tx, older.id, {
            status: "cancelled",
            eventType: "order_cancelled",
            reason: `Replaced by a newer checkout (${orderId})`,
            actor: "system",
          });
        }

        const taken = new Set<string>();
        const allocated: AllocatedUnit[] = [];
        const itemRows: Prisma.OrderItemCreateManyInput[] = [];
        for (const line of draft.ev.purchasable) {
          const { item } = line;
          const window = line.window!;
          const units = await allocateUnits(
            tx,
            { variantId: item.variantId, size: item.size, mode: item.mode, quantity: item.quantity, ...window, label: item.product.name },
            taken
          );
          allocated.push(...units);
          for (const unit of units) {
            itemRows.push({
              orderId,
              productId: item.productId,
              variantId: item.variantId,
              productName: item.product.name,
              color: item.variant.color,
              imageUrl: pickImageUrl(item.variant.imageUrls, item.product.coverImageUrl),
              garmentUnitId: unit.id,
              mode: item.mode,
              size: item.size,
              unitPricePaise: line.unitPricePaise,
              depositPaise: line.depositPaise,
              rentDays: item.mode === "rent" ? item.product.rentDays : null,
              rentStartDate: item.mode === "rent" ? window.start : null,
              rentReturnDate: item.mode === "rent" ? window.end : null,
            });
          }
        }

        const coupon = draft.ev.coupon?.applied ? draft.ev.coupon : null;
        await tx.order.create({
          data: {
            id: orderId,
            customerId: userId,
            status: "pending_payment",
            eventDate: rentStarts.length > 0 ? new Date(Math.min(...rentStarts)) : null,
            currency: ctx.currency,
            fxRateToBase: ctx.fxRate,
            subtotalPaise: draft.quote.subtotalPaise,
            discountPaise: draft.quote.discountPaise,
            deliveryFeePaise: draft.quote.deliveryFeePaise,
            totalPaise: draft.quote.totalPaise,
            depositTotalPaise: draft.quote.depositTotalPaise,
            couponId: coupon?.couponId ?? null,
            couponCode: coupon?.code ?? null,
            ...addressSnapshot(draft.address, user.email),
            deliveryMethod: draft.delivery.code,
            deliveryMethodLabel: draft.delivery.label,
            deliveryEtaMinDays: draft.delivery.minDays,
            deliveryEtaMaxDays: draft.delivery.maxDays,
            paymentExpiresAt: new Date(now.getTime() + BUSINESS_RULES.checkoutHoldMinutes * 60 * 1000),
            checkoutFingerprint: draft.fingerprint,
            sourceCartItemIds: draft.ev.purchasable.map((l) => l.item.id),
            idempotencyKey,
            createdVia: opts.createdVia ?? "shop",
          },
        });
        await tx.orderItem.createMany({ data: itemRows });
        await reserveUnits(tx, orderId, allocated, `Allocated for order ${orderId}`);
        await recordOrderEvent(tx, {
          orderId,
          type: "order_created",
          status: "pending_payment",
          message: "Order created — awaiting payment",
          actor: "customer",
          actorUserId: userId,
          metadata: { grandTotalPaise: draft.quote.grandTotalPaise, deliveryMethod: draft.delivery.code, couponCode: coupon?.code ?? null },
        });
      },
      { timeout: 20_000, maxWait: 10_000 }
    );
  } catch (err) {
    // Two concurrent requests with the same key: the loser replays the winner.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const winner = await prisma.order.findUnique({ where: { idempotencyKey } });
      if (winner && winner.customerId === userId) return { order: winner, replayed: true };
    }
    throw err;
  }

  return { order: await prisma.order.findUniqueOrThrow({ where: { id: orderId } }), replayed: false };
}
