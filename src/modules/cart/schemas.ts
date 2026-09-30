import { z } from "zod";
import { BUSINESS_RULES } from "../../config/business";

const startDateSchema = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "invalid startDate")
  .refine((v) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(v) >= today;
  }, "startDate cannot be in the past");

const quantitySchema = z.coerce
  .number()
  .int()
  .min(1, "Quantity must be at least 1")
  .max(BUSINESS_RULES.cart.maxQuantityPerLine, `You can add at most ${BUSINESS_RULES.cart.maxQuantityPerLine} of an item`);

const idSchema = z.string().trim().min(1).max(100);

export const addCartItemSchema = z.object({
  // Product.id is just `String @id`, not UUID-typed — seed/demo data uses
  // human-readable ids like "seed-product-blazer", so don't require UUID shape.
  productId: idSchema,
  // Optional for quick-add from product cards: the backend then picks the
  // product's first active colour that offers this size and has stock.
  variantId: idSchema.optional(),
  mode: z.enum(["rent", "buy"]),
  size: z.string().trim().min(1).max(20),
  quantity: quantitySchema.default(1),
  startDate: startDateSchema.optional(),
});

export const updateCartItemSchema = z
  .object({
    quantity: quantitySchema.optional(),
    startDate: startDateSchema.nullable().optional(),
  })
  .refine((v) => v.quantity !== undefined || v.startDate !== undefined, "Nothing to update");

export const removeCartItemQuerySchema = z.object({
  mode: z.enum(["rent", "buy"]).optional(),
});

export const applyCouponSchema = z.object({
  code: z.string().trim().min(1, "Enter a coupon code").max(40),
});

// Guest-cart lines coming from localStorage — lenient on dates (a stale
// past date is dropped rather than rejecting the whole merge).
export const mergeCartSchema = z.object({
  lines: z
    .array(
      z.object({
        productId: idSchema,
        variantId: idSchema.optional(),
        mode: z.enum(["rent", "buy"]),
        size: z.string().trim().min(1).max(20),
        quantity: z.coerce.number().int().min(1).max(99).default(1),
        startDate: z.string().optional(),
      })
    )
    .max(50),
});

export type AddCartItemInput = z.infer<typeof addCartItemSchema>;
export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;
export type MergeCartLine = z.infer<typeof mergeCartSchema>["lines"][number];
