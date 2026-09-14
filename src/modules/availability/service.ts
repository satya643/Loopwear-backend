import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { BUSINESS_RULES } from "../../config/business";
import { ApiError } from "../../lib/errors";

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * The single most important gap this backend closes (build spec §2 / §7.2):
 * the Shop's AvailabilityPicker showed a date field that never actually
 * checked a calendar. Availability is derived per (product, size, date
 * range) from real garment_units + their order_item history — not a static
 * flag on the product.
 *
 * A unit counts as free for [start, end) unless it is retired/sold, or an
 * active (non-cancelled) rental order_item on that unit overlaps the range.
 * Units mid-cycle (rented/laundry/etc.) are still counted as available for a
 * FUTURE window once their current booking's return date + a turnaround
 * buffer clears the requested start — the `stage` column is a snapshot of
 * "right now", not a calendar.
 *
 * Accepts either the default client or a transaction client so checkout can
 * re-run this exact check inside the allocation transaction (see
 * modules/checkout/service.ts) without duplicating the overlap logic.
 */
export async function findFreeUnitIds(
  client: Client,
  productId: string,
  size: string,
  start: Date,
  end: Date
): Promise<string[]> {
  const units = await client.garmentUnit.findMany({
    where: { productId, size, stage: { notIn: ["retired", "sold"] } },
    select: { id: true },
  });
  if (units.length === 0) return [];

  const unitIds = units.map((u) => u.id);
  const overlapping = await client.orderItem.findMany({
    where: {
      garmentUnitId: { in: unitIds },
      mode: "rent",
      rentStartDate: { not: null },
      rentReturnDate: { not: null },
      order: { status: { notIn: ["cancelled"] } },
    },
    select: { garmentUnitId: true, rentStartDate: true, rentReturnDate: true },
  });

  const bufferMs = BUSINESS_RULES.turnaroundBufferDays * 24 * 60 * 60 * 1000;
  const blocked = new Set<string>();
  for (const item of overlapping) {
    const effectiveEnd = new Date(item.rentReturnDate!.getTime() + bufferMs);
    if (item.rentStartDate! < end && effectiveEnd > start) {
      blocked.add(item.garmentUnitId!);
    }
  }
  return unitIds.filter((id) => !blocked.has(id));
}

export async function computeAvailableUnitCount(productId: string, size: string, start: Date, end: Date): Promise<number> {
  const ids = await findFreeUnitIds(prisma, productId, size, start, end);
  return ids.length;
}

export interface SizeAvailability {
  size: string;
  available: boolean;
  unitsFree: number;
}

export async function getSizeAvailability(productId: string, start: Date, end: Date): Promise<SizeAvailability[]> {
  if (end <= start) throw ApiError.badRequest("end date must be after start date");

  const sizes = await prisma.garmentUnit.findMany({
    where: { productId, stage: { notIn: ["retired", "sold"] } },
    distinct: ["size"],
    select: { size: true },
  });

  const results: SizeAvailability[] = [];
  for (const { size } of sizes) {
    const unitsFree = await computeAvailableUnitCount(productId, size, start, end);
    results.push({ size, available: unitsFree > 0, unitsFree });
  }
  return results;
}

export function defaultRentalWindow(rentDays: number): { start: Date; end: Date } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start.getTime() + rentDays * 24 * 60 * 60 * 1000);
  return { start, end };
}
