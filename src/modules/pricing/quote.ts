/**
 * The one place an order's money is computed. Pure (no DB, no FX) so the
 * cart, the review screen, order placement and the tests all get exactly
 * the same numbers. Everything is integer base-currency paise.
 *
 *   subtotal = Σ unitPrice × quantity          (rent + buy lines)
 *   total    = subtotal − discount + delivery  (what we earn)
 *   grand    = total + deposits                (what the customer is charged)
 *
 * Deposits are refundable, so coupons never discount them and they don't
 * count towards free-delivery thresholds.
 */

export interface QuoteLine {
  mode: "rent" | "buy";
  unitPricePaise: number;
  depositPaise: number;
  quantity: number;
}

export interface LineTotals {
  rentSubtotalPaise: number;
  buySubtotalPaise: number;
  subtotalPaise: number;
  depositTotalPaise: number;
  itemCount: number;
}

export interface Quote extends LineTotals {
  discountPaise: number;
  deliveryFeePaise: number;
  totalPaise: number;
  grandTotalPaise: number;
}

function assertPaise(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer number of paise (got ${value})`);
  }
}

export function sumLines(lines: QuoteLine[]): LineTotals {
  const totals: LineTotals = { rentSubtotalPaise: 0, buySubtotalPaise: 0, subtotalPaise: 0, depositTotalPaise: 0, itemCount: 0 };
  for (const line of lines) {
    assertPaise(line.unitPricePaise, "unitPricePaise");
    assertPaise(line.depositPaise, "depositPaise");
    if (!Number.isInteger(line.quantity) || line.quantity < 1) throw new Error(`quantity must be a positive integer (got ${line.quantity})`);

    const lineTotal = line.unitPricePaise * line.quantity;
    if (line.mode === "rent") {
      totals.rentSubtotalPaise += lineTotal;
      totals.depositTotalPaise += line.depositPaise * line.quantity;
    } else {
      totals.buySubtotalPaise += lineTotal;
    }
    totals.itemCount += line.quantity;
  }
  totals.subtotalPaise = totals.rentSubtotalPaise + totals.buySubtotalPaise;
  return totals;
}

export function computeQuote(input: { lines: QuoteLine[]; discountPaise?: number; deliveryFeePaise?: number }): Quote {
  const totals = sumLines(input.lines);
  const requestedDiscount = input.discountPaise ?? 0;
  const deliveryFeePaise = input.deliveryFeePaise ?? 0;
  assertPaise(requestedDiscount, "discountPaise");
  assertPaise(deliveryFeePaise, "deliveryFeePaise");

  // A discount can never make the goods negative (delivery is still owed).
  const discountPaise = Math.min(requestedDiscount, totals.subtotalPaise);
  const totalPaise = totals.subtotalPaise - discountPaise + deliveryFeePaise;
  return {
    ...totals,
    discountPaise,
    deliveryFeePaise,
    totalPaise,
    grandTotalPaise: totalPaise + totals.depositTotalPaise,
  };
}
