import { prisma } from "../../../lib/prisma";
import { BUSINESS_RULES } from "../../../config/business";
import { paginatedResponse, toSkipTake, type Pagination } from "../../../lib/pagination";

function computeTier(totalRentals: number, onTimeRate: number): "signature" | "member" | "new" {
  const { signatureMinRentals, signatureMinOnTimeRate, memberMinRentals } = BUSINESS_RULES.tiers;
  if (totalRentals >= signatureMinRentals && onTimeRate >= signatureMinOnTimeRate) return "signature";
  if (totalRentals >= memberMinRentals) return "member";
  return "new";
}

/**
 * `customers` is a view over orders, not a stored table (build spec §3):
 * total_rentals, on_time_rate and tier are all computed here rather than
 * cached and drifting out of sync with the order/order_item history.
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

  const items = await Promise.all(users.map((u) => buildCustomerSummary(u.id, u.name, u.email)));
  return paginatedResponse(items, total, pagination);
}

export async function getCustomer(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return buildCustomerSummary(user.id, user.name, user.email);
}

async function buildCustomerSummary(userId: string, name: string, email: string) {
  const rentItems = await prisma.orderItem.findMany({
    where: { mode: "rent", order: { customerId: userId, status: { not: "cancelled" } } },
    select: { rentReturnDate: true, actualReturnDate: true },
  });

  const totalRentals = rentItems.length;
  const returned = rentItems.filter((i) => i.actualReturnDate !== null);
  const onTime = returned.filter((i) => i.rentReturnDate && i.actualReturnDate! <= i.rentReturnDate);
  const onTimeRate = returned.length > 0 ? onTime.length / returned.length : 1;

  return {
    id: userId,
    name,
    email,
    totalRentals,
    onTimeRate: Math.round(onTimeRate * 100) / 100,
    tier: computeTier(totalRentals, onTimeRate),
  };
}
