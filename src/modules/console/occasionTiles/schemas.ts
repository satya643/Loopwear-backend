import { z } from "zod";

export const upsertOccasionTileSchema = z.object({
  imageUrl: z.string().url(),
  blurb: z.string().min(1).max(160),
});
