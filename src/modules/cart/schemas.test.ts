import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { addCartItemSchema } from "./schemas";

describe("addCartItemSchema.startDate", () => {
  const base = { productId: "seed-product-blazer", mode: "rent" as const, size: "M" };

  it("accepts today", () => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const result = addCartItemSchema.parse({ ...base, startDate: today.toISOString() });
    expect(result.startDate).toBe(today.toISOString());
  });

  it("accepts a future date", () => {
    const future = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => addCartItemSchema.parse({ ...base, startDate: future })).not.toThrow();
  });

  it("rejects a past date", () => {
    const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    expect(() => addCartItemSchema.parse({ ...base, startDate: past })).toThrow(ZodError);
  });

  it("rejects an unparseable date string", () => {
    expect(() => addCartItemSchema.parse({ ...base, startDate: "not-a-date" })).toThrow(ZodError);
  });

  it("is optional", () => {
    expect(() => addCartItemSchema.parse(base)).not.toThrow();
  });
});
