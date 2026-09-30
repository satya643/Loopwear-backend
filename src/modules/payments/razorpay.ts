import crypto from "crypto";
import Razorpay from "razorpay";
import type { PaymentMethod } from "@prisma/client";
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

export function isRazorpayConfigured(): boolean {
  return Boolean(env.razorpay.keyId && env.razorpay.keySecret);
}

/**
 * `notes.orderId` rides along on every payment/webhook payload for this
 * Razorpay order, so support can always trace a gateway event back to ours.
 */
export async function createRazorpayOrder(amountMinorUnits: number, currency: string, receipt: string) {
  return getRazorpay().orders.create({
    amount: amountMinorUnits,
    currency: currency.toUpperCase(),
    receipt,
    notes: { orderId: receipt },
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

export async function fetchRazorpayPayment(paymentId: string) {
  return getRazorpay().payments.fetch(paymentId);
}

/** Only needed when the account doesn't auto-capture (payment left `authorized`). */
export async function captureRazorpayPayment(paymentId: string, amountMinorUnits: number, currency: string) {
  return getRazorpay().payments.capture(paymentId, amountMinorUnits, currency);
}

/** Every payment attempt made against one Razorpay order — used to reconcile before expiring it. */
export async function fetchRazorpayOrderPayments(orderId: string) {
  const res = await getRazorpay().orders.fetchPayments(orderId);
  return res.items;
}

export async function createRazorpayRefund(paymentId: string, amountMinorUnits: number, notes?: Record<string, string>) {
  return getRazorpay().payments.refund(paymentId, { amount: amountMinorUnits, notes });
}

export async function fetchRazorpayOrder(orderId: string) {
  return getRazorpay().orders.fetch(orderId);
}

export function mapRazorpayMethod(method: string | undefined | null): PaymentMethod {
  switch (method) {
    case "card":
    case "emi":
      return "card";
    case "upi":
      return "upi";
    case "netbanking":
      return "netbanking";
    case "wallet":
      return "wallet";
    default:
      return "other";
  }
}
