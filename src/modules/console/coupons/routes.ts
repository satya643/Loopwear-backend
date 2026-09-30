import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateBody, validateQuery } from "../../../middleware/validate";
import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";
import { paginatedResponse, paginationSchema, toSkipTake } from "../../../lib/pagination";
import { normalizeCouponCode } from "../../coupons/evaluate";

export const consoleCouponsRouter = Router();
consoleCouponsRouter.use(requireAuth, requireRole("operator", "admin"));

const couponFields = z.object({
  code: z
    .string()
    .trim()
    .min(3)
    .max(40)
    .regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, - and _ only")
    .transform(normalizeCouponCode),
  description: z.string().trim().max(200).default(""),
  type: z.enum(["percent", "flat"]),
  // percent: 1-100; flat: paise
  value: z.number().int().positive(),
  maxDiscountPaise: z.number().int().positive().nullable().default(null),
  minSubtotalPaise: z.number().int().nonnegative().default(0),
  appliesTo: z.enum(["rent", "buy"]).nullable().default(null),
  startsAt: z.coerce.date().nullable().default(null),
  endsAt: z.coerce.date().nullable().default(null),
  usageLimit: z.number().int().positive().nullable().default(null),
  perUserLimit: z.number().int().positive().nullable().default(null),
  isActive: z.boolean().default(true),
});

const validRange = (c: { type?: string; value?: number; startsAt?: Date | null; endsAt?: Date | null }) =>
  (c.type !== "percent" || c.value === undefined || c.value <= 100) && (!c.startsAt || !c.endsAt || c.startsAt < c.endsAt);
const rangeMessage = { message: "Percent coupons must be 1–100, and startsAt must be before endsAt" };

const createSchema = couponFields.refine(validRange, rangeMessage);
const updateSchema = couponFields.partial().refine(validRange, rangeMessage);

function withUsage<T extends { id: string; _count: { redemptions: number } }>(c: T) {
  const { _count, ...rest } = c;
  return { ...rest, redemptionCount: _count.redemptions };
}

consoleCouponsRouter.get(
  "/",
  validateQuery(paginationSchema),
  asyncHandler(async (req, res) => {
    const p = req.query as unknown as z.infer<typeof paginationSchema>;
    const [rows, total] = await Promise.all([
      prisma.coupon.findMany({ orderBy: { createdAt: "desc" }, include: { _count: { select: { redemptions: true } } }, ...toSkipTake(p) }),
      prisma.coupon.count(),
    ]);
    res.json(paginatedResponse(rows.map(withUsage), total, p));
  })
);

consoleCouponsRouter.post(
  "/",
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    try {
      const coupon = await prisma.coupon.create({ data: req.body, include: { _count: { select: { redemptions: true } } } });
      res.status(201).json(withUsage(coupon));
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw ApiError.conflict(`Coupon ${req.body.code} already exists`);
      throw err;
    }
  })
);

consoleCouponsRouter.patch(
  "/:id",
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.coupon.findUnique({ where: { id: req.params.id } });
    if (!existing) throw ApiError.notFound("Coupon not found");
    const coupon = await prisma.coupon.update({
      where: { id: existing.id },
      data: req.body,
      include: { _count: { select: { redemptions: true } } },
    });
    res.json(withUsage(coupon));
  })
);
