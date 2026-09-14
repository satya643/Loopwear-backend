import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import { presentPricing, type PricingContext } from "../../lib/pricing";
import { paginatedResponse, toSkipTake, type Pagination } from "../../lib/pagination";
import { ORDER_STATUS_LABELS } from "../../lib/enumLabels";

function serializeOrder(order: any, ctx: PricingContext) {
  return {
    id: order.id,
    status: order.status,
    statusLabel: ORDER_STATUS_LABELS[order.status] ?? order.status,
    placedAt: order.placedAt,
    eventDate: order.eventDate,
    city: order.city,
    pricing: presentPricing({ totalPaise: order.totalPaise, depositTotalPaise: order.depositTotalPaise }, ctx),
    items:
      order.items?.map((item: any) => ({
        id: item.id,
        productId: item.productId,
        product: item.product
          ? { id: item.product.id, name: item.product.name, imageUrls: item.product.imageUrls }
          : undefined,
        mode: item.mode,
        size: item.size,
        rentStartDate: item.rentStartDate,
        rentReturnDate: item.rentReturnDate,
        actualReturnDate: item.actualReturnDate,
        pricing: presentPricing({ unitPricePaise: item.unitPricePaise, depositPaise: item.depositPaise }, ctx),
      })) ?? undefined,
  };
}

export async function listMyOrders(userId: string, pagination: Pagination, ctx: PricingContext) {
  const { skip, take } = toSkipTake(pagination);
  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where: { customerId: userId },
      include: { items: { include: { product: true } } },
      orderBy: { placedAt: "desc" },
      skip,
      take,
    }),
    prisma.order.count({ where: { customerId: userId } }),
  ]);
  return paginatedResponse(
    rows.map((o) => serializeOrder(o, ctx)),
    total,
    pagination
  );
}

export async function getMyOrder(userId: string, orderId: string, ctx: PricingContext) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: { include: { product: true } } },
  });
  if (!order || order.customerId !== userId) throw ApiError.notFound("Order not found");
  return serializeOrder(order, ctx);
}

/** Releases held units back to `available` — build spec §5 orders/cancel. */
export async function cancelMyOrder(userId: string, orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order || order.customerId !== userId) throw ApiError.notFound("Order not found");
  if (!["pending_payment", "confirmed"].includes(order.status)) {
    throw ApiError.conflict(`Cannot cancel an order in status "${order.status}"`);
  }

  await prisma.$transaction(async (tx) => {
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
          note: `Released: order ${orderId} cancelled`,
        },
      });
    }
    await tx.order.update({ where: { id: orderId }, data: { status: "cancelled" } });
  });
}
