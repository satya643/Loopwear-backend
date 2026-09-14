import { z } from "zod";
import { paginationSchema } from "../../lib/pagination";

export const listProductsQuerySchema = paginationSchema.extend({
  occasion: z.string().optional(),
  q: z.string().optional(),
  category: z.string().optional(),
  style: z.string().optional(),
  size: z.string().optional(),
  color: z.string().optional(),
  priceMin: z.coerce.number().nonnegative().optional(),
  priceMax: z.coerce.number().nonnegative().optional(),
});

export const availabilityQuerySchema = z.object({
  size: z.string().min(1),
  start: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "invalid start date"),
  end: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "invalid end date"),
});
