import rateLimit from "express-rate-limit";
import { env } from "../config/env";

/**
 * Rate limiting on /api/auth/* (build spec §6), keyed per-IP by default.
 * OTP-specific per-phone throttling (resend cooldown + daily cap) lives in
 * the OTP service itself since it needs to key on phone number, not IP.
 */
export const authRateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMinutes * 60 * 1000,
  max: env.rateLimit.maxAuthRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Too many requests, please try again later" } },
});

/**
 * Applied broadly to /api (see app.ts) — previously only /api/auth was
 * throttled at all, leaving checkout (real Stripe PaymentIntent per call),
 * cart, and every console endpoint completely unthrottled.
 */
export const generalRateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMinutes * 60 * 1000,
  max: env.rateLimit.maxGeneralRequests,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: "rate_limited", message: "Too many requests, please try again later" } },
});
