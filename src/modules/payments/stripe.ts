import Stripe from "stripe";
import { env } from "../../config/env";

let client: Stripe | null = null;

/** Lazily constructed so the app can boot without a Stripe key in dev/test. */
export function getStripe(): Stripe {
  if (!client) {
    if (!env.stripe.secretKey) {
      throw new Error("STRIPE_SECRET_KEY is not configured");
    }
    client = new Stripe(env.stripe.secretKey, { apiVersion: "2024-06-20" });
  }
  return client;
}

export async function createPaymentIntent(amountMinorUnits: number, currency: string, metadata: Record<string, string>) {
  return getStripe().paymentIntents.create({
    amount: amountMinorUnits,
    currency: currency.toLowerCase(),
    metadata,
    automatic_payment_methods: { enabled: true },
  });
}

export async function retrievePaymentIntent(id: string) {
  return getStripe().paymentIntents.retrieve(id);
}

export function constructWebhookEvent(payload: Buffer, signature: string): Stripe.Event {
  return getStripe().webhooks.constructEvent(payload, signature, env.stripe.webhookSecret);
}

export async function createRefund(paymentIntentId: string, amountMinorUnits: number) {
  return getStripe().refunds.create({ payment_intent: paymentIntentId, amount: amountMinorUnits });
}
