import { describe, expect, it } from "vitest";
import { evaluateCoupon, normalizeCouponCode, type CouponRule } from "./evaluate";

const base: CouponRule = {
  code: "WELCOME10",
  type: "percent",
  value: 10,
  maxDiscountPaise: null,
  minSubtotalPaise: 0,
  appliesTo: null,
  startsAt: null,
  endsAt: null,
  usageLimit: null,
  perUserLimit: null,
  isActive: true,
};
const noUsage = { totalRedemptions: 0, userRedemptions: 0 };
const cart = { rentSubtotalPaise: 100000, buySubtotalPaise: 200000 };
const now = new Date("2026-09-30T10:00:00Z");

describe("evaluateCoupon", () => {
  it("applies a percentage to the whole subtotal", () => {
    expect(evaluateCoupon(base, cart, noUsage, now)).toEqual({ ok: true, discountPaise: 30000, eligibleSubtotalPaise: 300000 });
  });

  it("caps a percentage at maxDiscountPaise", () => {
    const r = evaluateCoupon({ ...base, maxDiscountPaise: 5000 }, cart, noUsage, now);
    expect(r).toMatchObject({ ok: true, discountPaise: 5000 });
  });

  it("never discounts more than the eligible subtotal for flat coupons", () => {
    const r = evaluateCoupon({ ...base, type: "flat", value: 500000, appliesTo: "rent" }, cart, noUsage, now);
    expect(r).toMatchObject({ ok: true, discountPaise: 100000 });
  });

  it("scopes to rent or buy lines only", () => {
    expect(evaluateCoupon({ ...base, appliesTo: "buy" }, cart, noUsage, now)).toMatchObject({ discountPaise: 20000 });
    expect(evaluateCoupon({ ...base, appliesTo: "rent" }, { rentSubtotalPaise: 0, buySubtotalPaise: 1000 }, noUsage, now)).toMatchObject({
      ok: false,
      reason: "not_applicable",
    });
  });

  it.each([
    [{ isActive: false }, noUsage, "inactive"],
    [{ startsAt: new Date("2026-10-01T00:00:00Z") }, noUsage, "not_started"],
    [{ endsAt: new Date("2026-09-30T09:59:59Z") }, noUsage, "expired"],
    [{ usageLimit: 100 }, { totalRedemptions: 100, userRedemptions: 0 }, "usage_limit_reached"],
    [{ perUserLimit: 1 }, { totalRedemptions: 5, userRedemptions: 1 }, "per_user_limit_reached"],
    [{ minSubtotalPaise: 400000 }, noUsage, "min_subtotal_not_met"],
  ] as const)("rejects %o", (override, usage, reason) => {
    expect(evaluateCoupon({ ...base, ...override }, cart, usage, now)).toMatchObject({ ok: false, reason });
  });

  it("tells the customer how much more to add for a minimum spend", () => {
    const r = evaluateCoupon({ ...base, minSubtotalPaise: 350000 }, cart, noUsage, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("₹500");
  });
});

describe("normalizeCouponCode", () => {
  it("trims and upper-cases", () => {
    expect(normalizeCouponCode("  welcome10 ")).toBe("WELCOME10");
  });
});
