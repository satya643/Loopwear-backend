import { z } from "zod";

export const addCartItemSchema = z.object({
  // Product.id is just `String @id`, not UUID-typed — seed/demo data uses
  // human-readable ids like "seed-product-blazer", so don't require UUID shape.
  productId: z.string().min(1),
  mode: z.enum(["rent", "buy"]),
  size: z.string().min(1),
  startDate: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "invalid startDate")
    .refine((v) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return new Date(v) >= today;
    }, "startDate cannot be in the past")
    .optional(),
});

export const removeCartItemQuerySchema = z.object({
  mode: z.enum(["rent", "buy"]),
});
