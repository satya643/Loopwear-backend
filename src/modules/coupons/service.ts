import type { Coupon, Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { evaluateCoupon, normalizeCouponCode, type CouponEvaluation } from "./evaluate";

type Client = PrismaClient | Prisma.TransactionClient;

export type CouponResult =
  | { coupon: Coupon; evaluation: CouponEvaluation }
  | { coupon: null; evaluation: { ok: false; reason: "not_found"; message: string } };

/** Looks the code up, counts real (paid) redemptions, and evaluates it against these subtotals. */
export async function evaluateCouponCode(
  code: string,
  userId: string,
  subtotals: { rentSubtotalPaise: number; buySubtotalPaise: number },
  client: Client = prisma,
  now: Date = new Date()
): Promise<CouponResult> {
  const normalized = normalizeCouponCode(code);
  const coupon = await client.coupon.findUnique({ where: { code: normalized } });
  if (!coupon) {
    return { coupon: null, evaluation: { ok: false, reason: "not_found", message: `"${normalized}" isn't a valid coupon code` } };
  }
  const [totalRedemptions, userRedemptions] = await Promise.all([
    coupon.usageLimit !== null ? client.couponRedemption.count({ where: { couponId: coupon.id } }) : Promise.resolve(0),
    coupon.perUserLimit !== null ? client.couponRedemption.count({ where: { couponId: coupon.id, userId } }) : Promise.resolve(0),
  ]);
  return { coupon, evaluation: evaluateCoupon(coupon, subtotals, { totalRedemptions, userRedemptions }, now) };
}
