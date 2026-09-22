import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { generateOrderId } from "../../lib/orderId";
import { findFreeUnitIds } from "../availability/service";
import { convertPaise } from "../../lib/fx";
import { createPaymentIntent } from "../payments/stripe";
import { createRazorpayOrder } from "../payments/razorpay";
import { env } from "../../config/env";
import type { PricingContext } from "../../lib/pricing";
import type { Prisma } from "@prisma/client";

interface AllocationResult {
  garmentUnitId: string;
  fromStage: string;
}

/**
 * Locks and allocates one physical unit for a cart line, inside the caller's
 * transaction. Uses SELECT ... FOR UPDATE SKIP LOCKED on the specific
 * candidate rows so two simultaneous checkouts for the last unit of a size
 * can't both succeed (build spec §6 concurrency requirement) — one wins the
 * row lock, the other's candidate list comes back empty on retry and it
 * fails that line with a clear, specific error (§7.8 / §8's "fail that line
 * specifically" instruction).
 */
async function allocateUnitForLine(
  tx: Prisma.TransactionClient,
  productId: string,
  size: string,
  mode: "rent" | "buy",
  start: Date,
  end: Date
): Promise<AllocationResult> {
  const candidateIds =
    mode === "buy"
      ? (await tx.garmentUnit.findMany({ where: { variant: { productId }, size, stage: "available" }, select: { id: true } })).map(
          (u) => u.id
        )
      : await findFreeUnitIds(tx, productId, size, start, end);

  if (candidateIds.length === 0) {
    throw ApiError.conflict(`No ${size} units currently available for this item`, { productId, size, mode });
  }

  const locked = await tx.$queryRaw<{ id: string; stage: string }[]>`
    SELECT id, stage FROM "GarmentUnit"
    WHERE id = ANY(${candidateIds}) AND stage NOT IN ('retired', 'sold')
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  `;

  if (locked.length === 0) {
    throw ApiError.conflict(`The last available ${size} unit for this item was just taken, please retry`, {
      productId,
      size,
      mode,
    });
  }

  return { garmentUnitId: locked[0].id, fromStage: locked[0].stage };
}

export interface CheckoutInput {
  eventDate?: string;
  city?: string;
  idempotencyKey: string;
}

export async function checkout(userId: string, input: CheckoutInput, ctx: PricingContext) {
  const existing = await prisma.order.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) {
    if (existing.customerId !== userId) throw ApiError.conflict("Idempotency key already used by another customer");
    return buildCheckoutResponse(existing.id);
  }

  const cart = await prisma.cart.findUnique({ where: { userId }, include: { items: { include: { product: true } } } });
  if (!cart || cart.items.length === 0) throw ApiError.badRequest("Cart is empty");

  const orderId = generateOrderId();

  await prisma.$transaction(async (tx) => {
    let totalPaise = 0;
    let depositTotalPaise = 0;
    const itemRows: Prisma.OrderItemCreateManyInput[] = [];
    const unitUpdates: { id: string; toStage: "reserved"; fromStage: string }[] = [];

    for (const line of cart.items) {
      const start = line.mode === "rent" ? line.startDate ?? new Date() : new Date();
      const end = line.mode === "rent" ? new Date(start.getTime() + line.product.rentDays * 24 * 60 * 60 * 1000) : start;

      const allocation = await allocateUnitForLine(tx, line.productId, line.size, line.mode, start, end);
      unitUpdates.push({ id: allocation.garmentUnitId, toStage: "reserved", fromStage: allocation.fromStage });

      const unitPricePaise = line.mode === "rent" ? line.product.rentPricePaise : line.product.buyPricePaise;
      const depositPaise = line.mode === "rent" ? line.product.depositPaise : 0;
      totalPaise += unitPricePaise;
      depositTotalPaise += depositPaise;

      itemRows.push({
        orderId,
        productId: line.productId,
        garmentUnitId: allocation.garmentUnitId,
        mode: line.mode,
        size: line.size,
        unitPricePaise,
        depositPaise,
        rentDays: line.mode === "rent" ? line.product.rentDays : null,
        rentStartDate: line.mode === "rent" ? start : null,
        rentReturnDate: line.mode === "rent" ? end : null,
      });
    }

    await tx.order.create({
      data: {
        id: orderId,
        customerId: userId,
        eventDate: input.eventDate ? new Date(input.eventDate) : null,
        city: input.city,
        currency: ctx.currency,
        fxRateToBase: ctx.fxRate,
        totalPaise,
        depositTotalPaise,
        idempotencyKey: input.idempotencyKey,
      },
    });

    await tx.orderItem.createMany({ data: itemRows });

    for (const u of unitUpdates) {
      await tx.garmentUnit.update({
        where: { id: u.id },
        data: { stage: "reserved", currentOrderId: orderId, lastMovedAt: new Date() },
      });
      await tx.stageTransition.create({
        data: {
          garmentUnitId: u.id,
          fromStage: u.fromStage as never,
          toStage: "reserved",
          note: `Allocated at checkout for order ${orderId}`,
        },
      });
    }

    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
  });

  return buildCheckoutResponse(orderId);
}

async function buildCheckoutResponse(orderId: string) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  const existingPayment = await prisma.payment.findFirst({ where: { orderId, status: { in: ["pending", "paid"] } } });
  if (existingPayment) {
    return { order, payment: { id: existingPayment.id, status: existingPayment.status } };
  }

  const chargeCurrency = order.currency;
  const chargedAmountMinor = convertPaise(order.totalPaise + order.depositTotalPaise, order.fxRateToBase);

  // Razorpay is INR-first (UPI/cards/netbanking for Indian customers);
  // non-INR orders fall back to Stripe. Pick whichever gateway is actually
  // configured for this currency so checkout doesn't 500 on a missing key.
  const useRazorpay = chargeCurrency === "INR" && Boolean(env.razorpay.keyId && env.razorpay.keySecret);

  if (useRazorpay) {
    const rpOrder = await createRazorpayOrder(chargedAmountMinor, chargeCurrency, orderId);

    const payment = await prisma.payment.create({
      data: {
        orderId,
        customerId: order.customerId,
        amountPaise: order.totalPaise + order.depositTotalPaise,
        chargedAmountMinor,
        chargedCurrency: chargeCurrency,
        method: "card",
        gateway: "razorpay",
        gatewayRef: rpOrder.id,
      },
    });

    return {
      order,
      payment: {
        id: payment.id,
        status: payment.status,
        razorpayOrderId: rpOrder.id,
        razorpayKeyId: env.razorpay.keyId,
        amount: chargedAmountMinor,
        currency: chargeCurrency,
      },
    };
  }

  const intent = await createPaymentIntent(chargedAmountMinor, chargeCurrency, { orderId });

  const payment = await prisma.payment.create({
    data: {
      orderId,
      customerId: order.customerId,
      amountPaise: order.totalPaise + order.depositTotalPaise,
      chargedAmountMinor,
      chargedCurrency: chargeCurrency,
      method: "card",
      gateway: "stripe",
      gatewayRef: intent.id,
    },
  });

  return {
    order,
    payment: { id: payment.id, status: payment.status, clientSecret: intent.client_secret },
  };
}

/**
 * Undoes exactly what allocateUnitForLine did: every unit this order was
 * holding goes back to `available` (never back to its pre-checkout stage —
 * checkout only ever reserves units that were already `available`, per
 * allocateUnitForLine's own candidate query), the order moves to
 * `cancelled`, and any non-paid payment attached to it to `failed`.
 * Idempotent — safe to call on an order that's already been moved on for
 * any reason (skips it rather than erroring), so both the abandoned-
 * reservation job and an explicit gateway-failure callback can call this
 * without coordinating with each other.
 */
export async function releaseAbandonedOrder(orderId: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
    if (!order || order.status !== "pending_payment") return;

    for (const item of order.items) {
      if (!item.garmentUnitId) continue;
      const unit = await tx.garmentUnit.findUnique({ where: { id: item.garmentUnitId } });
      if (!unit || unit.currentOrderId !== orderId) continue;

      await tx.garmentUnit.update({
        where: { id: unit.id },
        data: { stage: "available", currentOrderId: null, lastMovedAt: new Date() },
      });
      await tx.stageTransition.create({
        data: { garmentUnitId: unit.id, fromStage: unit.stage, toStage: "available", note: reason },
      });
    }

    await tx.payment.updateMany({ where: { orderId, status: { not: "paid" } }, data: { status: "failed" } });
    await tx.order.update({ where: { id: orderId }, data: { status: "cancelled" } });
  });
}
