import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { resolveDisplayCurrency, getRateToBase } from "../lib/fx";
import { asyncHandler } from "../lib/asyncHandler";

function clientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress ?? null;
}

/**
 * Resolves the currency to display prices in for this request:
 * explicit override (?currency= or X-Currency header) > signed-in user's
 * preferredCurrency > user's saved country > IP geolocation > base currency.
 * Attaches req.currency + req.fxRate so route handlers can convert prices
 * without re-deriving this on every call. Build spec: currency decisions.
 */
export const resolveCurrency = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const queryCurrency =
    (req.query.currency as string | undefined) ?? (req.headers["x-currency"] as string | undefined);

  let userPreferredCurrency: string | null = null;
  let userCountry: string | null = null;

  if (req.auth) {
    const user = await prisma.user.findUnique({
      where: { id: req.auth.userId },
      select: { preferredCurrency: true, country: true },
    });
    userPreferredCurrency = user?.preferredCurrency ?? null;
    userCountry = user?.country ?? null;
  }

  const currency = await resolveDisplayCurrency({
    queryCurrency,
    userPreferredCurrency,
    userCountry,
    ip: clientIp(req),
  });

  req.currency = currency;
  req.fxRate = await getRateToBase(currency);
  next();
});
