import type { Request } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env";

const message = { error: { code: "rate_limited", message: "Too many requests, please try again later" } };

/**
 * Every shop request reaches this API from the Next.js server, so keying on
 * IP alone puts all shoppers in one bucket: 20 failed sign-ins anywhere
 * would lock out everyone. Keys therefore include who is acting:
 *  - credential endpoints: client IP + the email/phone being tried, so one
 *    attacker hammering one account is throttled without affecting others;
 *  - everything else: the signed-in user, else the client IP.
 * The real client IP comes from X-Forwarded-For, which Express only honours
 * as far as TRUST_PROXY allows (see app.ts) — so it can't be spoofed past a
 * proxy we don't trust.
 */
function identifierFrom(req: Request): string {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const raw = body.email ?? body.phone ?? "";
  return typeof raw === "string" ? raw.trim().toLowerCase().replace(/\s+/g, "") : "";
}

export const authRateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMinutes * 60 * 1000,
  max: env.rateLimit.maxAuthRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `auth:${req.ip}:${identifierFrom(req)}`,
  message,
});

/**
 * Applied broadly to /api (see app.ts) — checkout, cart and console
 * endpoints would otherwise be unthrottled.
 */
export const generalRateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMinutes * 60 * 1000,
  max: env.rateLimit.maxGeneralRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.auth ? `user:${req.auth.userId}` : `ip:${req.ip}`),
  message,
});

/** Placing orders creates gateway orders — tighter than the general limit, per customer. */
export const checkoutRateLimiter = rateLimit({
  windowMs: env.rateLimit.windowMinutes * 60 * 1000,
  max: env.rateLimit.maxCheckoutRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.auth ? `checkout:${req.auth.userId}` : `checkout-ip:${req.ip}`),
  message,
});
