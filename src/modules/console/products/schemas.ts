import { z } from "zod";
import { paginationSchema } from "../../../lib/pagination";
import { OCCASION_LABELS, occasionCodeFromLabel } from "../../../lib/enumLabels";

export const listProductsQuerySchema = paginationSchema.extend({
  q: z.string().optional(),
  categoryId: z.string().optional(),
  isActive: z.enum(["true", "false"]).optional(),
});

const OCCASION_CODES = new Set(Object.keys(OCCASION_LABELS));

// Accepts either the enum code ("DateNight") or the display label ("Date
// Night") — same as every other endpoint that takes an occasion (see
// catalog/routes.ts, outfits/routes.ts) — so the admin app can send whichever
// it already has on hand, instead of only the raw DB code.
const occasionInput = z.string().transform((value, ctx) => {
  const code = OCCASION_CODES.has(value) ? value : occasionCodeFromLabel(value);
  if (!code) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Unknown occasion "${value}"` });
    return z.NEVER;
  }
  return code;
});

const styleInput = z.enum(["Minimal", "Classic", "Street", "Formal", "Traditional", "Contemporary"]);

// Reconciled to match the shape the public catalog and shop frontend already
// use for these two JSON columns (baseSerialize in catalog/service.ts, and
// the Garment type in the shop app) — the original spec had imageUrls as a
// bare string[] and measurements as Record<string,string|number>, which
// would have made products created through this endpoint render broken on
// the shop's product page (wrong image-per-view lookup, wrong measurements
// shape). Flagged this in the previous turn; fixing it now rather than
// leaving two shapes live in the same column.
const productViewInput = z.enum(["front", "back", "fabric", "model", "detail"]);

// One entry per color the product comes in. `sizes` just declares which
// sizes this color is offered in (catalog metadata) — the actual stock is
// real GarmentUnit rows added afterward via POST /:id/units.
const variantInput = z.object({
  color: z.string().min(1),
  colorHex: z.string().min(1),
  views: z.array(productViewInput).default([]),
  imageUrls: z.record(productViewInput, z.string()).default({}),
  sizes: z.array(z.string().min(1)).min(1, "Select at least one size"),
  isActive: z.boolean().default(true),
});

const productFields = {
  name: z.string().min(1),
  brand: z.string().min(1),
  categoryId: z.string().min(1),
  occasions: z.array(occasionInput).default([]),
  styles: z.array(styleInput).default([]),
  rentPricePaise: z.number().int().nonnegative(),
  rentDays: z.number().int().nonnegative(),
  buyPricePaise: z.number().int().nonnegative(),
  depositPaise: z.number().int().nonnegative(),
  deliveryDays: z.number().int().nonnegative(),
  fabric: z.string().min(1),
  care: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  // Not in the spec's POST body list, but the GET response shape does include
  // `measurements`, and the Prisma column is required (no @default) — so a
  // product created without ever accepting this would never be settable.
  // Optional on input, defaults to [].
  measurements: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).default([]),
  description: z.string().default(""),
  // A URL, not a file — same contract as a variant's imageUrls (see
  // variantInput above): the admin panel uploads the file via
  // POST /console/uploads first and sends back the URL it gets.
  coverImageUrl: z.string().optional(),
  conditionCopy: z.string().min(1).default("Excellent condition, inspected before dispatch"),
};

// Create takes the product's own fields plus its initial set of color
// variants in one call (matches the admin's "Create Product" form, which
// builds the variant list client-side via "+ Add Another Color" before a
// single submit). Editing colors afterward goes through the dedicated
// variant endpoints below, never through PATCH /:id.
export const createProductSchema = z.object({
  ...productFields,
  variants: z.array(variantInput).min(1, "Add at least one color variant"),
});

export const updateProductSchema = z.object(productFields).partial();

export const addVariantSchema = variantInput;
export const updateVariantSchema = variantInput.partial();

export const addUnitSchema = z.object({
  variantId: z.string().min(1),
  sku: z.string().min(1),
  size: z.string().min(1),
  facilityId: z.string().min(1).optional(),
});
