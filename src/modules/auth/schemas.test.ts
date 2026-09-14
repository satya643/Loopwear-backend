import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { signUpSchema, verifyOtpSchema } from "./schemas";

describe("phone validation (signUpSchema)", () => {
  const base = { name: "Jane Doe", email: "jane@example.com", password: "correct-horse-battery" };

  it("accepts a valid E.164 Indian number and normalizes it", () => {
    const result = signUpSchema.parse({ ...base, phone: "+919876543210" });
    expect(result.phone).toBe("+919876543210");
  });

  it("normalizes a valid number with spaces/formatting to E.164", () => {
    const result = signUpSchema.parse({ ...base, phone: "+91 98765 43210" });
    expect(result.phone).toBe("+919876543210");
  });

  it("accepts a valid US number", () => {
    const result = signUpSchema.parse({ ...base, phone: "+14155552671" });
    expect(result.phone).toBe("+14155552671");
  });

  it("rejects a number missing the country code", () => {
    expect(() => signUpSchema.parse({ ...base, phone: "9876543210" })).toThrow(ZodError);
  });

  it("rejects an impossible (too short) number", () => {
    expect(() => signUpSchema.parse({ ...base, phone: "+91123" })).toThrow(ZodError);
  });

  it("rejects a malformed/garbage phone value", () => {
    expect(() => signUpSchema.parse({ ...base, phone: "not-a-phone" })).toThrow(ZodError);
  });

  it("rejects a missing phone field entirely (raw Postman-style payload)", () => {
    expect(() => signUpSchema.parse({ ...base })).toThrow(ZodError);
  });

  it("rejects a valid-looking but non-existent-region number", () => {
    // Correct length for +1 but not a valid NANP number pattern.
    expect(() => signUpSchema.parse({ ...base, phone: "+10000000000" })).toThrow(ZodError);
  });
});

describe("phone validation (verifyOtpSchema)", () => {
  it("rejects an invalid phone even with a well-formed code", () => {
    expect(() => verifyOtpSchema.parse({ phone: "12345", code: "123456" })).toThrow(ZodError);
  });

  it("accepts a valid phone with a 6-digit code", () => {
    const result = verifyOtpSchema.parse({ phone: "+919876543210", code: "123456" });
    expect(result.phone).toBe("+919876543210");
  });
});
