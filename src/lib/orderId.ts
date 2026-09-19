import { randomBytes } from "crypto";

/**
 * Human-readable order ids like ORD-8K3F9A2B1C3D, matching the Concourse's
 * ORD-8841 style. The random segment must be high-entropy: under concurrent
 * checkout traffic within the same millisecond-bucket window, a short/weak
 * random suffix (previously 2 base36 chars = 1296 combinations) is a real
 * collision risk against the `Order.id` primary key.
 */
export function generateOrderId(): string {
  const stamp = Date.now().toString(36).toUpperCase().slice(-4);
  const rand = randomBytes(5).toString("hex").toUpperCase();
  return `ORD-${stamp}${rand}`;
}
