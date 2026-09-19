import { describe, expect, it } from "vitest";
import { generateResetToken, hashResetToken } from "./resetToken";

describe("resetToken", () => {
  it("generates a long, URL-safe random token", () => {
    const token = generateResetToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generates a different token every call", () => {
    expect(generateResetToken()).not.toBe(generateResetToken());
  });

  it("hashes deterministically so a raw token can be looked up by hash", () => {
    const token = generateResetToken();
    expect(hashResetToken(token)).toBe(hashResetToken(token));
  });

  it("produces different hashes for different tokens", () => {
    expect(hashResetToken(generateResetToken())).not.toBe(hashResetToken(generateResetToken()));
  });
});
