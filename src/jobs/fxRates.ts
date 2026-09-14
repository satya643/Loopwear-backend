import { prisma } from "../lib/prisma";
import { env } from "../config/env";

/**
 * Refreshes FxRate (base currency -> target) used by lib/fx.ts for display
 * pricing. Tries a live provider first; falls back to a static seed table so
 * the app still works (currency conversion just goes stale) when no FX API
 * is configured — see .env.example FX_RATE_API_KEY/FX_RATE_API_URL.
 */
const FALLBACK_RATES: Record<string, number> = {
  USD: 0.012,
  GBP: 0.0095,
  EUR: 0.011,
  CAD: 0.016,
  AUD: 0.018,
  AED: 0.044,
  SGD: 0.016,
  NZD: 0.02,
  JPY: 1.8,
  CNY: 0.086,
};

async function fetchLiveRates(): Promise<Record<string, number> | null> {
  if (!env.currency.fxApiKey) return null;
  try {
    const symbols = Object.keys(FALLBACK_RATES).join(",");
    const url = `${env.currency.fxApiUrl}?base=${env.currency.base}&symbols=${symbols}&access_key=${env.currency.fxApiKey}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { rates?: Record<string, number> };
    return data.rates ?? null;
  } catch {
    return null;
  }
}

export async function runFxRatesJob() {
  const rates = (await fetchLiveRates()) ?? FALLBACK_RATES;

  await prisma.$transaction(
    Object.entries(rates).map(([targetCurrency, rate]) =>
      prisma.fxRate.upsert({
        where: { baseCurrency_targetCurrency: { baseCurrency: env.currency.base, targetCurrency } },
        update: { rate, updatedAt: new Date() },
        create: { baseCurrency: env.currency.base, targetCurrency, rate },
      })
    )
  );
}

if (require.main === module) {
  runFxRatesJob()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("FX rates refreshed");
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
