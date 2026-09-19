import crypto from "crypto";
import Razorpay from "razorpay";
import { env } from "../../config/env";

let client: Razorpay | null = null;

/** Lazily constructed so the app can boot without Razorpay keys in dev/test. */
export function getRazorpay(): Razorpay {
  if (!client) {
    if (!env.razorpay.keyId || !env.razorpay.keySecret) {
      throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not configured");
    }
    client = new Razorpay({ key_id: env.razorpay.keyId, key_secret: env.razorpay.keySecret });
  }
  return client;
}

export async function createRazorpayOrder(amountMinorUnits: number, currency: string, receipt: string) {
  return getRazorpay().orders.create({
    amount: amountMinorUnits,
    currency: currency.toUpperCase(),
    receipt,
  });
}

/**
 * Razorpay's checkout flow returns order id + payment id + a signature the
 * client cannot forge (it's HMAC-SHA256 of "order_id|payment_id" using the
 * account's key secret, which never reaches the browser). Recomputing and
 * comparing it is how we know the payment is genuine before marking an
 * order paid — never trust the client's "it succeeded" on its own.
 */
export function verifyPaymentSignature(orderId: string, paymentId: string, signature: string): boolean {
  const expected = crypto
    .createHmac("sha256", env.razorpay.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest("hex");
  return safeCompare(expected, signature);
}

/** Same idea for webhooks: the raw body is signed with the webhook secret (distinct from the key secret). */
export function verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
  if (!env.razorpay.webhookSecret) return false;
  const expected = crypto.createHmac("sha256", env.razorpay.webhookSecret).update(rawBody).digest("hex");
  return safeCompare(expected, signature);
}

function safeCompare(expectedHex: string, actualHex: string): boolean {
  const a = Buffer.from(expectedHex);
  const b = Buffer.from(actualHex);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export async function createRazorpayRefund(paymentId: string, amountMinorUnits: number) {
  return getRazorpay().payments.refund(paymentId, { amount: amountMinorUnits });
}

export async function fetchRazorpayOrder(orderId: string) {
  return getRazorpay().orders.fetch(orderId);
}
