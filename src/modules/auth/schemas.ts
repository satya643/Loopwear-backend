import { z } from "zod";
import { isPossiblePhoneNumber, isValidPhoneNumber, parsePhoneNumber } from "libphonenumber-js";

// Backend is the source of truth for phone validation — never trust a
// frontend-normalized number. Requires an explicit country code (e.g.
// +919876543210) since we have no default-country context to assume from.
export const phoneSchema = z
  .string()
  .trim()
  .superRefine((value, ctx) => {
    if (!isPossiblePhoneNumber(value)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Phone must include a country code and a valid number of digits, e.g. +919876543210",
      });
      return;
    }
    if (!isValidPhoneNumber(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Phone number is not valid" });
    }
  })
  // Normalize to E.164 regardless of what formatting the frontend sent.
  .transform((value) => parsePhoneNumber(value)!.number);

export const signUpSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().transform((v) => v.toLowerCase()),
  phone: phoneSchema,
  password: z.string().min(8).max(128),
});

export const verifyOtpSchema = z.object({
  phone: phoneSchema,
  code: z.string().length(6),
});

export const resendOtpSchema = z.object({
  phone: phoneSchema,
});

export const signInSchema = z.object({
  email: z.string().email().transform((v) => v.toLowerCase()),
  password: z.string().min(1),
});

export const requestOtpLoginSchema = z.object({
  phone: phoneSchema,
});

export const continueWithGoogleSchema = z.object({
  idToken: z.string().min(1),
});
