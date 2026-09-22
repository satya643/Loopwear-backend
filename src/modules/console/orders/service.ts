import type { OrderStatus } from "@prisma/client";
import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";
import { paginatedResponse, toSkipTake, type Pagination } from "../../../lib/pagination";
import { ORDER_STATUS_LABELS } from "../../../lib/enumLabels";

const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  pending_payment: ["confirmed", "cancelled"],
  confirmed: ["packed", "cancelled"],
  packed: ["shipped"],
  shipped: ["with_customer"],
  with_customer: ["return_in_transit"],
  return_in_transit: ["closed"],
  closed: [],
  cancelled: [],
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
    totalPaise: order.totalPaise,
    depositTotalPaise: order.depositTotalPaise,
    currency: order.currency,
    payments: order.payments,
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
      payments: true,
      deliveryJobs: true,
    },
  });
  if (!order) throw ApiError.notFound("Order not found");
  return serializeOrder(order);
}

/**
 * `shipped` is where a rent order's units actually leave the rack: this is
 * the "reserved -> rented" hop in the garment lifecycle, driven here rather
 * than requiring an operator to also separately walk every unit through the
 * inventory endpoint (build spec §3: "reserved -> rented (dispatched)").
 * `cancelled` releases any still-reserved units back to `available`.
 */
export async function setOrderStatus(id: string, toStatus: OrderStatus, actorUserId: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
  if (!order) throw ApiError.notFound("Order not found");

  if (!ORDER_TRANSITIONS[order.status]?.includes(toStatus)) {
    throw ApiError.conflict(`Cannot move an order from "${order.status}" to "${toStatus}"`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.order.update({ where: { id }, data: { status: toStatus } });

    if (toStatus === "shipped") {
      for (const item of order.items) {
        if (item.mode !== "rent" || !item.garmentUnitId) continue;
        const unit = await tx.garmentUnit.findUnique({ where: { id: item.garmentUnitId } });
        if (!unit || unit.stage !== "reserved") continue;
        await tx.garmentUnit.update({ where: { id: unit.id }, data: { stage: "rented", lastMovedAt: new Date() } });
        await tx.stageTransition.create({
          data: {
            garmentUnitId: unit.id,
            fromStage: "reserved",
            toStage: "rented",
            actorUserId,
            note: `Dispatched with order ${id}`,
          },
        });
      }
    }

    if (toStatus === "cancelled") {
      for (const item of order.items) {
        if (!item.garmentUnitId) continue;
        const unit = await tx.garmentUnit.findUnique({ where: { id: item.garmentUnitId } });
        if (!unit || unit.stage !== "reserved") continue;
        await tx.garmentUnit.update({
          where: { id: unit.id },
          data: { stage: "available", currentOrderId: null, lastMovedAt: new Date() },
        });
        await tx.stageTransition.create({
          data: {
            garmentUnitId: unit.id,
            fromStage: "reserved",
            toStage: "available",
            actorUserId,
            note: `Released: order ${id} cancelled by operator`,
          },
        });
      }
    }
  });

  return getOrder(id);
}
