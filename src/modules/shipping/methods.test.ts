import { afterEach, describe, expect, it } from "vitest";
import { BUSINESS_RULES } from "../../config/business";
import { addDeliveryDays, checkServiceable, listDeliveryOptions, resolveDeliveryOption } from "./methods";
import { ApiError } from "../../lib/errors";

const blr = { country: "IN", postalCode: "560001" };
// A Friday, so the ETA crosses a Sunday.
const friday = new Date(2026, 9, 2, 10, 0, 0);

const original = structuredClone(BUSINESS_RULES.delivery.methods);
afterEach(() => {
  BUSINESS_RULES.delivery.methods.splice(0, BUSINESS_RULES.delivery.methods.length, ...structuredClone(original));
});

describe("addDeliveryDays", () => {
  it("skips Sundays", () => {
    // Fri + 2 delivery days = Sat, (skip Sun), Mon
    expect(addDeliveryDays(friday, 2).getDay()).toBe(1);
    expect(addDeliveryDays(friday, 1).getDay()).toBe(6);
  });
});

describe("checkServiceable", () => {
  it("accepts Indian 6-digit PIN codes only", () => {
    expect(checkServiceable(blr).ok).toBe(true);
    expect(checkServiceable({ country: "IN", postalCode: "012345" }).ok).toBe(false);
    expect(checkServiceable({ country: "US", postalCode: "94107" }).ok).toBe(false);
  });
});

describe("listDeliveryOptions", () => {
  it("returns every configured method with fee and ETA", () => {
    const options = listDeliveryOptions(blr, 100000, friday);
    expect(options.map((o) => o.code)).toEqual(["standard", "express"]);
    expect(options.every((o) => o.available)).toBe(true);
    expect(options[0].feePaise).toBe(5000);
    expect(options[1].estimatedTo.getTime()).toBeLessThan(options[0].estimatedTo.getTime());
  });

  it("waives the fee above the free-delivery threshold", () => {
    BUSINESS_RULES.delivery.methods[0].freeAboveSubtotalPaise = 200000;
    expect(listDeliveryOptions(blr, 199999, friday)[0].feePaise).toBe(5000);
    expect(listDeliveryOptions(blr, 200000, friday)[0]).toMatchObject({ feePaise: 0, baseFeePaise: 5000 });
  });

  it("marks a method unavailable outside its PIN prefixes", () => {
    BUSINESS_RULES.delivery.methods[1].pincodePrefixes = ["110"];
    const express = listDeliveryOptions(blr, 0, friday)[1];
    expect(express.available).toBe(false);
    expect(express.unavailableReason).toContain("560001");
  });
});

describe("resolveDeliveryOption", () => {
  it("throws delivery_unavailable for unknown, inactive or unserviceable methods", () => {
    const expectCode = (fn: () => unknown) => {
      try {
        fn();
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).code).toBe("delivery_unavailable");
        expect((err as ApiError).status).toBe(422);
      }
    };
    expectCode(() => resolveDeliveryOption("drone", blr, 0));
    expectCode(() => resolveDeliveryOption("standard", { country: "IN", postalCode: "1234" }, 0));
    BUSINESS_RULES.delivery.methods[1].active = false;
    expectCode(() => resolveDeliveryOption("express", blr, 0));
  });
});
