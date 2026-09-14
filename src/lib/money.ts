/**
 * All prices are stored as integer minor units (paise) in the base currency
 * (INR by default — see env.currency.base). Never use floats for money.
 */
export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function paiseToRupees(paise: number): number {
  return paise / 100;
}

export function isNonNegativeInt(n: number): boolean {
  return Number.isInteger(n) && n >= 0;
}
