import type { OrderStatus } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";
import { paginatedResponse, toSkipTake, type Pagination } from "../../../lib/pagination";
import { ORDER_STATUS_LABELS } from "../../../lib/enumLabels";
import { BUSINESS_RULES } from "../../../config/business";
import { recordOrderEvent } from "../../orders/events";
import { cancelOrder } from "../../orders/service";

// Only a verified payment confirms an order (payments/finalize.ts): an
// operator can cancel an unpaid order but never mark one paid. A buy-only
// order is done once delivered (with_customer → closed); rentals come back
// first (return_in_transit → closed).
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ["cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["shipped"],
  shipped: ["with_customer"],
  with_customer: ["return_in_transit", "closed"],
  return_in_transit: ["closed"],
  closed: [],
  cancelled: [],
  payment_failed: [],
  refunded: [],
};

function serializeOrder(order: any) {
  return {
    id: order.id,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status] ?? order.status,
    customer: order.customer ? { id: order.customer.id, name: order.customer.name, email: order.customer.email } : undefined,
    customerName: order.customer?.name,
    garmentNames: order.items?.map((item: any) => item.product?.name).filter(Boolean),
    placedAt: order.placedAt,
    eventDate: order.eventDate,
    city: order.city,
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
    subtotalPaise: order.subtotalPaise,
    discountPaise: order.discountPaise,
    deliveryFeePaise: order.deliveryFeePaise,
    totalPaise: order.totalPaise,
    depositTotalPaise: order.depositTotalPaise,
    grandTotalPaise: order.totalPaise + order.depositTotalPaise,
    couponCode: order.couponCode,
    deliveryMethod: order.deliveryMethod,
    deliveryMethodLabel: order.deliveryMethodLabel,
    paymentExpiresAt: order.paymentExpiresAt,
    confirmedAt: order.confirmedAt,
    cancelledAt: order.cancelledAt,
    cancelReason: order.cancelReason,
    currency: order.currency,
    allowedNextStatuses: ORDER_TRANSITIONS[order.status as OrderStatus] ?? [],
    payments: order.payments,
    refunds: order.refunds,
    events: order.events,
    deliveryJobs: order.deliveryJobs,
    items: order.items,
  };
}

export async function listOrders(filters: { status?: string; q?: string }, pagination: Pagination) {
  const where: import("@prisma/client").Prisma.OrderWhereInput = {};
  if (filters.status) where.status = filters.status as never;
  if (filters.q) {
    where.OR = [
      { id: { contains: filters.q, mode: "insensitive" } },
      { customer: { name: { contains: filters.q, mode: "insensitive" } } },
      { customer: { email: { contains: filters.q, mode: "insensitive" } } },
    ];
  }

  const { skip, take } = toSkipTake(pagination);
  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        customer: { select: { id: true, name: true, email: true } },
        items: { include: { product: { select: { name: true } } } },
      },
      orderBy: { placedAt: "desc" },
      skip,
      take,
    }),
    prisma.order.count({ where }),
  ]);
  return paginatedResponse(rows.map(serializeOrder), total, pagination);
}

export async function getOrder(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      customer: { select: { id: true, name: true, email: true } },
      items: { include: { product: { select: { id: true, name: true } }, garmentUnit: true } },
      payments: { orderBy: { createdAt: "desc" } },
      refunds: { orderBy: { createdAt: "asc" } },
      events: { orderBy: { createdAt: "asc" } },
      deliveryJobs: true,
    },
  });
  if (!order) throw ApiError.notFound("Order not found");
  return serializeOrder(order);
}

/**
 * Operator status changes. Every change is a guarded transition (it only
 * applies if the order is still in the status the operator saw) and is
 * written to the order's timeline.
 *  - `cancelled` goes through the same path as a customer cancel: stock
 *    released and, for a paid order, a full refund.
 *  - `shipped` is where a rent order's units actually leave the rack
 *    ("reserved → rented"), and where the dropoff DeliveryJob is created.
 */
export async function setOrderStatus(id: string, toStatus: OrderStatus, actorUserId: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
  if (!order) throw ApiError.notFound("Order not found");

  if (!ORDER_TRANSITIONS[order.status]?.includes(toStatus)) {
    throw ApiError.conflict(`Cannot move an order from "${order.status}" to "${toStatus}"`);
  }

  if (toStatus === "cancelled") {
    await cancelOrder(id, { actor: "operator", actorUserId });
    return getOrder(id);
  }

  await prisma.$transaction(async (tx) => {
    const moved = await tx.order.updateMany({ where: { id, status: order.status }, data: { status: toStatus } });
    if (moved.count === 0) throw ApiError.conflict("This order was updated by someone else — reload and try again");

    if (toStatus === "shipped") {
      for (const item of order.items) {
        if (item.mode !== "rent" || !item.garmentUnitId) continue;
        const unit = await tx.garmentUnit.findUnique({ where: { id: item.garmentUnitId } });
        // `available`: a unit booked while it was busy elsewhere, back on the rack by now.
        if (!unit || (unit.stage !== "reserved" && unit.stage !== "available")) continue;
        await tx.garmentUnit.update({
          where: { id: unit.id },
          data: { stage: "rented", currentOrderId: id, lastMovedAt: new Date(), timesRented: { increment: 1 } },
        });
        await tx.stageTransition.create({
          data: { garmentUnitId: unit.id, fromStage: unit.stage, toStage: "rented", actorUserId, note: `Dispatched with order ${id}` },
        });
      }

      const alreadyHasDropoff = await tx.deliveryJob.findFirst({ where: { orderId: id, type: "dropoff" } });
      if (!alreadyHasDropoff) {
        const windowStart = new Date();
        const windowEnd = new Date(windowStart.getTime() + BUSINESS_RULES.defaultDeliveryWindowDays * 24 * 60 * 60 * 1000);
        await tx.deliveryJob.create({
          data: { type: "dropoff", orderId: id, windowStart, windowEnd, zone: order.city ?? "Unassigned" },
        });
      }
    }

    await recordOrderEvent(tx, {
      orderId: id,
      type: "status_changed",
      status: toStatus,
      message: `Status changed to ${ORDER_STATUS_LABELS[toStatus] ?? toStatus}`,
      actor: "operator",
      actorUserId,
    });
  });

  return getOrder(id);
}
