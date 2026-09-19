import { describe, expect, it } from "vitest";
import { isSupportedCurrency, currencyForCountry, convertPaise } from "./fx";

describe("isSupportedCurrency", () => {
  it("accepts known currencies case-insensitively", () => {
    expect(isSupportedCurrency("INR")).toBe(true);
    expect(isSupportedCurrency("usd")).toBe(true);
    expect(isSupportedCurrency("Gbp")).toBe(true);
  });

  it("rejects an unsupported/junk currency code", () => {
    expect(isSupportedCurrency("ZZZZ")).toBe(false);
    expect(isSupportedCurrency("")).toBe(false);
  });
});

describe("currencyForCountry", () => {
  it("maps a known country to its currency", () => {
    expect(currencyForCountry("US")).toBe("USD");
    expect(currencyForCountry("in")).toBe("INR");
  });

  it("falls back to the base currency for an unmapped/missing country", () => {
    expect(currencyForCountry("ZZ")).toBe("INR");
    expect(currencyForCountry(null)).toBe("INR");
  });
});

describe("convertPaise", () => {
  it("rounds to the nearest integer minor unit", () => {
    expect(convertPaise(100, 1)).toBe(100);
    expect(convertPaise(100, 0.012)).toBe(1);
    expect(convertPaise(333, 1.005)).toBe(335);
  });
});
