import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { countAvailableUnits, rentalWindow, startOfToday } from "../availability/service";

type Client = PrismaClient | Prisma.TransactionClient;

export const cartItemWithRelations = Prisma.validator<Prisma.CartItemDefaultArgs>()({
  include: { product: true, variant: { include: { sizes: true } } },
});
export type CartItemWithRelations = Prisma.CartItemGetPayload<typeof cartItemWithRelations>;

export type LineIssueCode =
  | "product_unavailable"
  | "variant_unavailable"
  | "out_of_stock"
  | "insufficient_stock"
  | "rental_date_invalid"
  | "price_changed";

export interface LineIssue {
  code: LineIssueCode;
  message: string;
  /** Blocking issues must be fixed (remove / reduce / re-date) before checkout. */
  blocking: boolean;
  available?: number;
  previousUnitPricePaise?: number;
  currentUnitPricePaise?: number;
}

export interface ValidatedLine {
  item: CartItemWithRelations;
  /** Current DB prices — the only prices anything is ever charged at. */
  unitPricePaise: number;
  depositPaise: number;
  available: number;
  window: { start: Date; end: Date } | null;
  issues: LineIssue[];
  status: "ok" | "warning" | "blocked";
}

export function currentLinePrices(item: Pick<CartItemWithRelations, "mode" | "product">) {
  return item.mode === "rent"
    ? { unitPricePaise: item.product.rentPricePaise, depositPaise: item.product.depositPaise }
    : { unitPricePaise: item.product.buyPricePaise, depositPaise: 0 };
}

function formatPaise(paise: number) {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/**
 * Re-checks every line against the database *now*: product still published,
 * colour still offered in that size, enough stock for the quantity (and the
 * rental window), rental date not in the past, and whether the price moved
 * since the customer added it. Never trusts anything stored on the line
 * except which item/quantity/date the customer chose.
 */
export async function validateCartItems(items: CartItemWithRelations[], client: Client = prisma): Promise<ValidatedLine[]> {
  const today = startOfToday();
  const results: ValidatedLine[] = [];

  for (const item of items) {
    const { unitPricePaise, depositPaise } = currentLinePrices(item);
    const issues: LineIssue[] = [];
    let available = 0;
    let window: ValidatedLine["window"] = null;

    const productOk = item.product.isActive;
    const variantOk =
      item.variant.isActive && item.variant.productId === item.productId && item.variant.sizes.some((s) => s.size === item.size);

    if (!productOk) {
      issues.push({ code: "product_unavailable", message: `${item.product.name} is no longer available`, blocking: true });
    } else if (!variantOk) {
      issues.push({
        code: "variant_unavailable",
        message: `${item.product.name} in ${item.variant.color}, size ${item.size} is no longer offered`,
        blocking: true,
      });
    } else {
      if (item.mode === "rent" && item.startDate && item.startDate < today) {
        issues.push({ code: "rental_date_invalid", message: "The rental start date has passed — pick a new date", blocking: true });
      }
      window = item.mode === "rent" ? rentalWindow(item.startDate, item.product.rentDays) : { start: today, end: today };
      available = await countAvailableUnits(client, {
        variantId: item.variantId,
        size: item.size,
        mode: item.mode,
        start: window.start,
        end: window.end,
      });
      if (available === 0) {
        issues.push({ code: "out_of_stock", message: `${item.product.name} (${item.size}) is out of stock`, blocking: true, available });
      } else if (available < item.quantity) {
        issues.push({
          code: "insufficient_stock",
          message: `Only ${available} of ${item.product.name} (${item.size}) left — reduce the quantity`,
          blocking: true,
          available,
        });
      }
    }

    const snapshotChanged =
      item.unitPricePaiseSnapshot !== null &&
      (item.unitPricePaiseSnapshot !== unitPricePaise ||
        (item.depositPaiseSnapshot !== null && item.depositPaiseSnapshot !== depositPaise));
    if (productOk && snapshotChanged) {
      issues.push({
        code: "price_changed",
        message: `Price of ${item.product.name} changed from ${formatPaise(item.unitPricePaiseSnapshot!)} to ${formatPaise(unitPricePaise)}`,
        blocking: false,
        previousUnitPricePaise: item.unitPricePaiseSnapshot!,
        currentUnitPricePaise: unitPricePaise,
      });
    }

    const status = issues.some((i) => i.blocking) ? "blocked" : issues.length > 0 ? "warning" : "ok";
    results.push({ item, unitPricePaise, depositPaise, available, window, issues, status });
  }
  return results;
}
