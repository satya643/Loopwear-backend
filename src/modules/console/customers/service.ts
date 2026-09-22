import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";
import { BUSINESS_RULES } from "../../../config/business";
import { paginatedResponse, toSkipTake, type Pagination } from "../../../lib/pagination";

function computeTier(totalRentals: number, onTimeRate: number): "signature" | "member" | "new" {
  const { signatureMinRentals, signatureMinOnTimeRate, memberMinRentals } = BUSINESS_RULES.tiers;
  if (totalRentals >= signatureMinRentals && onTimeRate >= signatureMinOnTimeRate) return "signature";
  if (totalRentals >= memberMinRentals) return "member";
  return "new";
}

type RentItem = { rentReturnDate: Date | null; actualReturnDate: Date | null };

function summarize(user: { id: string; name: string; email: string; createdAt: Date }, rentItems: RentItem[]) {
  const totalRentals = rentItems.length;
  const returned = rentItems.filter((i) => i.actualReturnDate !== null);
  const onTime = returned.filter((i) => i.rentReturnDate && i.actualReturnDate! <= i.rentReturnDate);
  const onTimeRate = returned.length > 0 ? onTime.length / returned.length : 1;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    memberSince: user.createdAt,
    totalRentals,
    onTimeRate: Math.round(onTimeRate * 100) / 100,
    tier: computeTier(totalRentals, onTimeRate),
  };
}

/**
 * `customers` is a view over orders, not a stored table (build spec §3):
 * total_rentals, on_time_rate and tier are all computed here rather than
 * cached and drifting out of sync with the order/order_item history.
 *
 * Fetches every page-user's rent items in ONE query (grouped in memory by
 * customerId) instead of one query per user — the previous version issued
 * 1 + pageSize queries per page.
 */
export async function listCustomers(filters: { q?: string }, pagination: Pagination) {
  const where: import("@prisma/client").Prisma.UserWhereInput = { role: "customer" };
  if (filters.q) {
    where.OR = [
      { name: { contains: filters.q, mode: "insensitive" } },
      { email: { contains: filters.q, mode: "insensitive" } },
    ];
  }

  const { skip, take } = toSkipTake(pagination);
  const [users, total] = await Promise.all([
    prisma.user.findMany({ where, skip, take, orderBy: { createdAt: "desc" } }),
    prisma.user.count({ where }),
  ]);

  const userIds = users.map((u) => u.id);
  const rentItems = await prisma.orderItem.findMany({
    where: { mode: "rent", order: { customerId: { in: userIds }, status: { not: "cancelled" } } },
    select: { rentReturnDate: true, actualReturnDate: true, order: { select: { customerId: true } } },
  });

  const byCustomer = new Map<string, RentItem[]>();
  for (const item of rentItems) {
    const list = byCustomer.get(item.order.customerId) ?? [];
    list.push({ rentReturnDate: item.rentReturnDate, actualReturnDate: item.actualReturnDate });
    byCustomer.set(item.order.customerId, list);
  }

  const items = users.map((u) => summarize(u, byCustomer.get(u.id) ?? []));
  return paginatedResponse(items, total, pagination);
}

export async function getCustomer(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.notFound("Customer not found");

  const rentItems = await prisma.orderItem.findMany({
    where: { mode: "rent", order: { customerId: userId, status: { not: "cancelled" } } },
    select: { rentReturnDate: true, actualReturnDate: true },
  });
  return summarize(user, rentItems);
}
