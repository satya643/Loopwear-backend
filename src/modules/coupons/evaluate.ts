import type { CartMode, DiscountType } from "@prisma/client";

/**
 * Coupon rules, kept pure so every caller (cart read, order preview, order
 * placement) applies them identically. Usage counts come from
 * CouponRedemption, which is only written once an order is paid — an
 * abandoned checkout never uses up a customer's coupon.
 */

export interface CouponRule {
  code: string;
  type: DiscountType;
  value: number;
  maxDiscountPaise: number | null;
  minSubtotalPaise: number;
  appliesTo: CartMode | null;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  perUserLimit: number | null;
  isActive: boolean;
}

export interface CouponUsage {
  totalRedemptions: number;
  userRedemptions: number;
}

export type CouponRejection =
  | "inactive"
  | "not_started"
  | "expired"
  | "usage_limit_reached"
  | "per_user_limit_reached"
  | "not_applicable"
  | "min_subtotal_not_met";

export type CouponEvaluation =
  | { ok: true; discountPaise: number; eligibleSubtotalPaise: number }
  | { ok: false; reason: CouponRejection; message: string };

export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
}

function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

export function evaluateCoupon(
  coupon: CouponRule,
  subtotals: { rentSubtotalPaise: number; buySubtotalPaise: number },
  usage: CouponUsage,
  now: Date = new Date()
): CouponEvaluation {
  if (!coupon.isActive) return { ok: false, reason: "inactive", message: `Coupon ${coupon.code} is no longer active` };
  if (coupon.startsAt && coupon.startsAt > now) {
    return { ok: false, reason: "not_started", message: `Coupon ${coupon.code} isn't active yet` };
  }
  if (coupon.endsAt && coupon.endsAt <= now) {
    return { ok: false, reason: "expired", message: `Coupon ${coupon.code} has expired` };
  }
  if (coupon.usageLimit !== null && usage.totalRedemptions >= coupon.usageLimit) {
    return { ok: false, reason: "usage_limit_reached", message: `Coupon ${coupon.code} has been fully redeemed` };
  }
  if (coupon.perUserLimit !== null && usage.userRedemptions >= coupon.perUserLimit) {
    return { ok: false, reason: "per_user_limit_reached", message: `You've already used coupon ${coupon.code}` };
  }

  const eligibleSubtotalPaise =
    coupon.appliesTo === "rent"
      ? subtotals.rentSubtotalPaise
      : coupon.appliesTo === "buy"
        ? subtotals.buySubtotalPaise
        : subtotals.rentSubtotalPaise + subtotals.buySubtotalPaise;

  if (eligibleSubtotalPaise <= 0) {
    const scope = coupon.appliesTo === "rent" ? "rentals" : coupon.appliesTo === "buy" ? "purchases" : "items";
    return { ok: false, reason: "not_applicable", message: `Coupon ${coupon.code} only applies to ${scope}` };
  }
  if (eligibleSubtotalPaise < coupon.minSubtotalPaise) {
    return {
      ok: false,
      reason: "min_subtotal_not_met",
      message: `Add ${rupees(coupon.minSubtotalPaise - eligibleSubtotalPaise)} more to use ${coupon.code} (minimum ${rupees(coupon.minSubtotalPaise)})`,
    };
  }

  let discountPaise =
    coupon.type === "percent" ? Math.floor((eligibleSubtotalPaise * coupon.value) / 100) : coupon.value;
  if (coupon.maxDiscountPaise !== null) discountPaise = Math.min(discountPaise, coupon.maxDiscountPaise);
  discountPaise = Math.min(discountPaise, eligibleSubtotalPaise);

  return { ok: true, discountPaise, eligibleSubtotalPaise };
}
