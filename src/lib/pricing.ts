import { convertPaise } from "./fx";
import { env } from "../config/env";

export interface PricingContext {
  currency: string;
  fxRate: number;
}

function stripPaiseSuffix(key: string): string {
  return key.endsWith("Paise") ? key.slice(0, -"Paise".length) : key;
}

/**
 * Attaches a display-currency conversion alongside the canonical base-currency
 * (paise) figures. Base figures are always present so downstream accounting
 * never depends on a live FX read.
 *
 * `display` keys drop the `...Paise` suffix (e.g. rentPricePaise -> rentPrice)
 * because those values are decimal amounts in the display currency, not
 * minor units — keeping the "Paise" name on a converted USD/GBP/etc amount
 * would be misleading to anything consuming this API.
 */
export function presentPricing(paiseFields: Record<string, number>, ctx: PricingContext) {
  const display: Record<string, number> = {};
  for (const [key, paise] of Object.entries(paiseFields)) {
    display[stripPaiseSuffix(key)] = convertPaise(paise, ctx.fxRate) / 100;
  }
  return {
    baseCurrency: env.currency.base,
    displayCurrency: ctx.currency,
    fxRate: ctx.fxRate,
    base: paiseFields,
    display,
  };
}
