import { randomBytes, createHash } from "crypto";

/** Raw, URL-safe token handed to the user (in the email link). */
export function generateResetToken(): string {
  return randomBytes(32).toString("hex");
}

/** Deterministic digest stored in the DB so the raw token can be looked up directly. */
export function hashResetToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
