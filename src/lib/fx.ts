import geoip from "geoip-lite";
import { prisma } from "./prisma";
import { env } from "../config/env";

/**
 * Country -> ISO 4217 currency code. Not exhaustive, but covers the markets
 * LoopWear is likely to see. Anything unmapped falls back to the base currency.
 */
const COUNTRY_CURRENCY: Record<string, string> = {
  IN: "INR",
  US: "USD",
  GB: "GBP",
  CA: "CAD",
  AU: "AUD",
  AE: "AED",
  SG: "SGD",
  DE: "EUR",
  FR: "EUR",
  ES: "EUR",
  IT: "EUR",
  NL: "EUR",
  IE: "EUR",
  NZ: "NZD",
  JP: "JPY",
  CN: "CNY",
};

export function currencyForCountry(countryCode?: string | null): string {
  if (!countryCode) return env.currency.base;
  return COUNTRY_CURRENCY[countryCode.toUpperCase()] ?? env.currency.base;
}

const SUPPORTED_CURRENCIES = new Set<string>([env.currency.base, ...Object.values(COUNTRY_CURRENCY)]);

/**
 * A client-supplied currency (?currency= or X-Currency) was previously
 * trusted as-is: junk like "ZZZZ" would flow through to `getRateToBase`
 * (silently falls back to rate=1) and then to Stripe's `paymentIntents.create`,
 * which rejects an invalid ISO currency with an opaque error. This doesn't
 * let a client manipulate the actual charged amount (paise + rate are always
 * server-resolved), it's purely a missing-validation robustness gap.
 */
export function isSupportedCurrency(code: string): boolean {
  return SUPPORTED_CURRENCIES.has(code.toUpperCase());
}

export function countryFromIp(ip?: string | null): string | null {
  if (!ip) return null;
  // Strip IPv6-mapped-IPv4 prefix commonly seen behind proxies (::ffff:1.2.3.4)
  const cleaned = ip.replace(/^::ffff:/, "");
  const lookup = geoip.lookup(cleaned);
  return lookup?.country ?? null;
}

/**
 * Rates are stored base(INR) -> target, refreshed by the fxRates job
 * (src/jobs/fxRates.ts). Missing/self rate falls back to 1.0 so the API
 * degrades to base-currency pricing rather than failing.
 */
export async function getRateToBase(targetCurrency: string): Promise<number> {
  if (targetCurrency === env.currency.base) return 1;
  const row = await prisma.fxRate.findUnique({
    where: {
      baseCurrency_targetCurrency: {
        baseCurrency: env.currency.base,
        targetCurrency,
      },
    },
  });
  return row?.rate ?? 1;
}

export function convertPaise(amountPaiseBase: number, rate: number): number {
  // Assumes a 2-decimal minor unit for the target currency, true for every
  // currency in COUNTRY_CURRENCY above except JPY (0 decimals).
  return Math.round(amountPaiseBase * rate);
}

export interface MoneyDisplay {
  baseCurrency: string;
  displayCurrency: string;
  fxRate: number;
}

export async function resolveDisplayCurrency(opts: {
  queryCurrency?: string;
  userPreferredCurrency?: string | null;
  userCountry?: string | null;
  ip?: string | null;
}): Promise<string> {
  if (opts.queryCurrency && isSupportedCurrency(opts.queryCurrency)) return opts.queryCurrency.toUpperCase();
  if (opts.userPreferredCurrency && isSupportedCurrency(opts.userPreferredCurrency)) {
    return opts.userPreferredCurrency.toUpperCase();
  }
  if (opts.userCountry) return currencyForCountry(opts.userCountry);
  const geoCountry = countryFromIp(opts.ip);
  if (geoCountry) return currencyForCountry(geoCountry);
  return env.currency.base;
}
