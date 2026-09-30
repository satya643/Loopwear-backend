import { z } from "zod";
import { phoneSchema } from "../auth/schemas";
import { canonicalIndiaState, INDIA_PIN_CODE } from "../../lib/indiaStates";

// Strips control characters and collapses runs of whitespace — addresses
// end up on shipping labels and in ops screens, so no hidden characters.
function clean(value: unknown) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim() : value;
}

const text = (min: number, max: number, label: string) =>
  z.preprocess(
    clean,
    z
      .string({ required_error: `${label} is required` })
      .min(min, `${label} must be at least ${min} characters`)
      .max(max, `${label} must be at most ${max} characters`)
  );

const optionalText = (max: number, label: string) =>
  z.preprocess(
    (v) => {
      const c = clean(v);
      return c === "" || c === null ? undefined : c;
    },
    z.string().max(max, `${label} must be at most ${max} characters`).optional()
  );

// Customers type Indian mobiles without a country code; the backend is the
// one place that normalises them to E.164.
const addressPhoneSchema = z.preprocess((v) => {
  const c = typeof v === "string" ? v.replace(/[\s()-]/g, "") : v;
  return typeof c === "string" && /^[6-9]\d{9}$/.test(c) ? `+91${c}` : c;
}, phoneSchema);

export const addressFieldsSchema = z.object({
  label: z.preprocess((v) => clean(v) || undefined, z.string().max(30, "Label must be at most 30 characters").default("Home")),
  fullName: text(2, 80, "Full name").refine((v) => /\p{L}/u.test(v), "Full name must contain letters"),
  phone: addressPhoneSchema,
  line1: text(3, 120, "Address line 1"),
  line2: optionalText(120, "Address line 2"),
  landmark: optionalText(80, "Landmark"),
  city: text(2, 60, "City").refine((v) => /^[\p{L} .'-]+$/u.test(v), "City can only contain letters, spaces, . ' and -"),
  state: z.preprocess(clean, z.string({ required_error: "State is required" })),
  postalCode: z.preprocess(
    (v) => (typeof v === "string" ? v.replace(/\s/g, "") : v),
    z.string({ required_error: "PIN code is required" }).regex(INDIA_PIN_CODE, "Enter a valid 6-digit PIN code")
  ),
  country: z.literal("IN", { errorMap: () => ({ message: "We currently deliver within India only" }) }).default("IN"),
});

function withCanonicalState<T extends { state?: string }>(schema: z.ZodType<T, z.ZodTypeDef, unknown>) {
  return schema.transform((value, ctx) => {
    if (value.state === undefined) return value;
    const state = canonicalIndiaState(value.state);
    if (!state) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["state"], message: "Select a valid Indian state or union territory" });
      return z.NEVER;
    }
    return { ...value, state };
  });
}

export const createAddressSchema = withCanonicalState(addressFieldsSchema.extend({ isDefault: z.boolean().optional() }));

export const updateAddressSchema = withCanonicalState(
  addressFieldsSchema
    .partial()
    .extend({ isDefault: z.boolean().optional() })
    .refine((v) => Object.keys(v).length > 0, "Nothing to update")
);

export type AddressInput = z.infer<typeof createAddressSchema>;
