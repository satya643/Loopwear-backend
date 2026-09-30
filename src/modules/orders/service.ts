import { Prisma, type OrderItem } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { presentPricing, type PricingContext } from "../../lib/pricing";
import { paginatedResponse, toSkipTake, type Pagination } from "../../lib/pagination";
import { addDeliveryDays } from "../shipping/methods";
import { refundPaymentFully } from "../payments/refunds";
import { closeUnpaidOrder } from "./lifecycle";
import { recordOrderEvent } from "./events";
import { releaseOrderInventory, returnSoldUnitsToStock } from "./inventory";
import { buildTimeline, CUSTOMER_STATUS_LABELS } from "./timeline";

const orderDetailArgs = Prisma.validator<Prisma.OrderDefaultArgs>()({
  include: {
    items: { include: { product: { select: { id: true, name: true, coverImageUrl: true } } } },
    events: { orderBy: { createdAt: "asc" } },
    payments: { orderBy: { createdAt: "desc" } },
    refunds: { orderBy: { createdAt: "asc" } },
  },
});
type OrderDetail = Prisma.OrderGetPayload<typeof orderDetailArgs>;
type OrderWithItems = Prisma.OrderGetPayload<{ include: { items: { include: { product: { select: { id: true; name: true; coverImageUrl: true } } } } } }>;

/** Amounts are shown in the currency the order was charged in, not today's geo-detected one. */
function orderCtx(order: { currency: string; fxRateToBase: number }): PricingContext {
  return { currency: order.currency, fxRate: order.fxRateToBase };
}

type ItemWithProduct = OrderItem & { product: { id: string; name: string; coverImageUrl: string | null } | null };

/** One order_item row per physical unit → one line per (colour, size, mode, dates, price) with a quantity. */
function groupLines(items: ItemWithProduct[], ctx: PricingContext) {
  const groups = new Map<string, { first: ItemWithProduct; quantity: number }>();
  for (const item of items) {
    const key = [item.variantId ?? item.productId, item.size, item.mode, item.rentStartDate?.toISOString() ?? "", item.unitPricePaise, item.depositPaise].join("|");
    const g = groups.get(key);
    if (g) g.quantity += 1;
    else groups.set(key, { first: item, quantity: 1 });
  }
  return [...groups.entries()].map(([key, { first, quantity }]) => ({
    key,
    productId: first.productId,
    variantId: first.variantId,
    productName: first.productName ?? first.product?.name ?? "Item",
    color: first.color,
    imageUrl: first.imageUrl ?? first.product?.coverImageUrl ?? null,
    mode: first.mode,
    size: first.size,
    quantity,
    rentStartDate: first.rentStartDate,
    rentReturnDate: first.rentReturnDate,
    pricing: presentPricing(
      {
        unitPricePaise: first.unitPricePaise,
        depositPaise: first.depositPaise,
        lineTotalPaise: first.unitPricePaise * quantity,
        lineDepositPaise: first.depositPaise * quantity,
      },
      ctx
    ),
  }));
}

function orderPricing(order: OrderWithItems, ctx: PricingContext) {
  return presentPricing(
    {
      subtotalPaise: order.subtotalPaise,
      discountPaise: order.discountPaise,
      deliveryFeePaise: order.deliveryFeePaise,
      totalPaise: order.totalPaise,
      depositTotalPaise: order.depositTotalPaise,
      grandTotalPaise: order.totalPaise + order.depositTotalPaise,
    },
    ctx
  );
}

function isPayable(order: { status: string; paymentExpiresAt: Date | null }) {
  return order.status === "pending_payment" && (!order.paymentExpiresAt || order.paymentExpiresAt > new Date());
}

function serializeOrderSummary(order: OrderWithItems) {
  const ctx = orderCtx(order);
  const lines = groupLines(order.items, ctx);
  return {
    id: order.id,
    status: order.status,
    statusLabel: CUSTOMER_STATUS_LABELS[order.status],
    placedAt: order.placedAt,
    confirmedAt: order.confirmedAt,
    eventDate: order.eventDate,
    city: order.city,
    isPayable: isPayable(order),
    paymentExpiresAt: order.paymentExpiresAt,
    itemCount: order.items.length,
    lines,
    pricing: orderPricing(order, ctx),
  };
}

function serializeOrderDetail(order: OrderDetail) {
  const ctx = orderCtx(order);
  const hasRentals = order.items.some((i) => i.mode === "rent");
  const latestPayment = order.payments[0] ?? null;
  const etaBase = order.confirmedAt ?? order.placedAt;
  return {
    ...serializeOrderSummary(order),
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    canCancel: order.status === "pending_payment" || order.status === "confirmed",
    delivery: {
      fullName: order.deliveryName,
      email: order.deliveryEmail,
      phone: order.deliveryPhone,
      addressLine1: order.deliveryAddressLine1,
      addressLine2: order.deliveryAddressLine2,
      city: order.city,
      state: order.deliveryState,
      postalCode: order.deliveryPostalCode,
      country: order.deliveryCountry,
      deliveryNote: order.deliveryNote,
    },
    deliveryMethod: order.deliveryMethod
      ? {
          code: order.deliveryMethod,
          label: order.deliveryMethodLabel,
          estimatedFrom: order.deliveryEtaMinDays !== null ? addDeliveryDays(etaBase, order.deliveryEtaMinDays) : null,
          estimatedTo: order.deliveryEtaMaxDays !== null ? addDeliveryDays(etaBase, order.deliveryEtaMaxDays) : null,
        }
      : null,
    couponCode: order.couponCode,
    payment: latestPayment
      ? {
          status: latestPayment.status,
          gateway: latestPayment.gateway,
          method: latestPayment.method,
          paidAt: latestPayment.paidAt,
          failureReason: latestPayment.status === "paid" ? null : latestPayment.failureReason,
        }
      : null,
    refunds: order.refunds.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt,
      processedAt: r.processedAt,
      pricing: presentPricing({ amountPaise: r.amountPaise }, ctx),
    })),
    timeline: buildTimeline(order, order.events, hasRentals),
    // Per-unit rows, kept for clients built against the previous shape.
    items: order.items.map((item) => ({
      id: item.id,
      productId: item.productId,
      product: item.product ? { id: item.product.id, name: item.productName ?? item.product.name } : undefined,
      mode: item.mode,
      size: item.size,
      rentStartDate: item.rentStartDate,
      rentReturnDate: item.rentReturnDate,
      actualReturnDate: item.actualReturnDate,
      pricing: presentPricing({ unitPricePaise: item.unitPricePaise, depositPaise: item.depositPaise }, ctx),
    })),
  };
}

export async function listMyOrders(userId: string, pagination: Pagination) {
  const { skip, take } = toSkipTake(pagination);
  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where: { customerId: userId },
      include: { items: { include: { product: { select: { id: true, name: true, coverImageUrl: true } } } } },
      orderBy: { placedAt: "desc" },
      skip,
      take,
    }),
    prisma.order.count({ where: { customerId: userId } }),
  ]);
  return paginatedResponse(rows.map(serializeOrderSummary), total, pagination);
}

async function loadOwnedOrder(userId: string, orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, ...orderDetailArgs });
  // Someone else's order reads as "not found", never "forbidden".
  if (!order || order.customerId !== userId) throw ApiError.notFound("Order not found");
  return order;
}

export async function getMyOrder(userId: string, orderId: string) {
  return serializeOrderDetail(await loadOwnedOrder(userId, orderId));
}

/** Small, pollable: what the confirmation page watches while a payment settles. */
export async function getMyOrderStatus(userId: string, orderId: string) {
  const order = await loadOwnedOrder(userId, orderId);
  const latestPayment = order.payments[0] ?? null;
  return {
    id: order.id,
    status: order.status,
    statusLabel: CUSTOMER_STATUS_LABELS[order.status],
    isPayable: isPayable(order),
    paymentExpiresAt: order.paymentExpiresAt,
    payment: latestPayment ? { status: latestPayment.status, failureReason: latestPayment.status === "paid" ? null : latestPayment.failureReason } : null,
    timeline: buildTimeline(order, order.events, order.items.some((i) => i.mode === "rent")),
  };
}

/**
 * Cancellation, shared by the customer and the console:
 *  - unpaid (`pending_payment`): release stock, nothing to refund;
 *  - paid but not yet packed (`confirmed`): release rental holds, put bought
 *    units back in stock, then refund the payment in full;
 *  - anything later: too late to cancel (409).
 */
export async function cancelOrder(
  orderId: string,
  opts: { actor: "customer" | "operator"; actorUserId: string; ownerUserId?: string; reason?: string }
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order || (opts.ownerUserId && order.customerId !== opts.ownerUserId)) throw ApiError.notFound("Order not found");
  const reason = opts.reason ?? (opts.actor === "customer" ? "Cancelled by customer" : "Cancelled by LoopWear");

  if (order.status === "pending_payment") {
    const closed = await prisma.$transaction((tx) =>
      closeUnpaidOrder(tx, orderId, { status: "cancelled", eventType: "order_cancelled", reason, actor: opts.actor, actorUserId: opts.actorUserId })
    );
    if (closed) return;
  } else if (order.status === "confirmed") {
    const cancelled = await prisma.$transaction(async (tx) => {
      const res = await tx.order.updateMany({
        where: { id: orderId, status: "confirmed" },
        data: { status: "cancelled", cancelledAt: new Date(), cancelReason: reason },
      });
      if (res.count === 0) return false;
      await releaseOrderInventory(tx, orderId, `Released: ${reason}`, opts.actorUserId);
      await returnSoldUnitsToStock(tx, orderId, `Returned to stock: ${reason}`, opts.actorUserId);
      await recordOrderEvent(tx, { orderId, type: "order_cancelled", status: "cancelled", message: reason, actor: opts.actor, actorUserId: opts.actorUserId });
      return true;
    });
    if (cancelled) {
      const paid = await prisma.payment.findFirst({ where: { orderId, status: { in: ["paid", "partially_refunded"] } } });
      if (paid) await refundPaymentFully(paid.id, reason, { actor: opts.actor, actorUserId: opts.actorUserId });
      return;
    }
  }

  const current = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
  throw ApiError.conflict(`This order can no longer be cancelled (it's ${CUSTOMER_STATUS_LABELS[current.status].toLowerCase()})`, { status: current.status });
}
