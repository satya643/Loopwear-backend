import { describe, expect, it } from "vitest";
import { computeQuote, sumLines } from "./quote";

describe("sumLines", () => {
  it("splits rent and buy subtotals and multiplies by quantity", () => {
    const totals = sumLines([
      { mode: "rent", unitPricePaise: 49900, depositPaise: 100000, quantity: 2 },
      { mode: "buy", unitPricePaise: 249900, depositPaise: 0, quantity: 1 },
    ]);
    expect(totals).toEqual({
      rentSubtotalPaise: 99800,
      buySubtotalPaise: 249900,
      subtotalPaise: 349700,
      depositTotalPaise: 200000,
      itemCount: 3,
    });
  });

  it("never charges a deposit on buy lines even if one is passed", () => {
    expect(sumLines([{ mode: "buy", unitPricePaise: 1000, depositPaise: 500, quantity: 1 }]).depositTotalPaise).toBe(0);
  });

  it("rejects fractional money and non-positive quantities", () => {
    expect(() => sumLines([{ mode: "buy", unitPricePaise: 10.5, depositPaise: 0, quantity: 1 }])).toThrow();
    expect(() => sumLines([{ mode: "buy", unitPricePaise: 100, depositPaise: 0, quantity: 0 }])).toThrow();
  });
});

describe("computeQuote", () => {
  const lines = [
    { mode: "rent" as const, unitPricePaise: 50000, depositPaise: 100000, quantity: 1 },
    { mode: "buy" as const, unitPricePaise: 150000, depositPaise: 0, quantity: 1 },
  ];

  it("total = subtotal - discount + delivery, grand total adds deposits", () => {
    const q = computeQuote({ lines, discountPaise: 20000, deliveryFeePaise: 5000 });
    expect(q.subtotalPaise).toBe(200000);
    expect(q.totalPaise).toBe(185000);
    expect(q.grandTotalPaise).toBe(285000);
  });

  it("caps the discount at the subtotal — delivery is still owed", () => {
    const q = computeQuote({ lines, discountPaise: 999999, deliveryFeePaise: 5000 });
    expect(q.discountPaise).toBe(200000);
    expect(q.totalPaise).toBe(5000);
    expect(q.grandTotalPaise).toBe(105000);
  });

  it("handles an empty cart", () => {
    expect(computeQuote({ lines: [] }).grandTotalPaise).toBe(0);
  });
});
