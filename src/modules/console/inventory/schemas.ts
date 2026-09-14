import { z } from "zod";
import { paginationSchema } from "../../../lib/pagination";

export const listUnitsQuerySchema = paginationSchema.extend({
  stage: z.string().optional(),
  q: z.string().optional(),
});

export const transitionSchema = z.object({
  toStage: z.enum([
    "available",
    "reserved",
    "rented",
    "returned",
    "inspection",
    "laundry",
    "quality",
    "ready",
    "retired",
    "sold",
  ]),
  condition: z.enum(["excellent", "good", "fair", "needs_review"]).optional(),
  note: z.string().max(500).optional(),
});
