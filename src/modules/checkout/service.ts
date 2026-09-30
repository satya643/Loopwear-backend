import { prisma } from "../../lib/prisma";
import { ApiError } from "../../lib/errors";
import type { PricingContext } from "../../lib/pricing";
import { BUSINESS_RULES } from "../../config/business";
import { evaluateCart, serializeCart, cartBlockers } from "../cart/service";
import { createAddress, listAddresses } from "../addresses/service";
import { createAddressSchema } from "../addresses/schemas";
import { listDeliveryOptions, serializeDeliveryOption } from "../shipping/methods";
import { placeOrder } from "../orders/placement";
import { createPaymentSession } from "../payments/session";

/**
 * Everything the checkout page needs in one call, only for a signed-in
 * customer (guests get 401 from requireAuth and are sent to sign-in with
 * redirectTo=/checkout). The cart is fully re-validated here.
 */
export async function getCheckoutSummary(userId: string, ctx: PricingContext) {
  const [ev, addresses] = await Promise.all([evaluateCart(userId), listAddresses(userId)]);
  const defaultAddress = addresses.find((a) => a.isDefault) ?? addresses[0] ?? null;
  const subtotalAfterDiscount = ev.quote.subtotalPaise - ev.quote.discountPaise;
  const blockers = cartBlockers(ev);
  return {
    cart: serializeCart(ev, ctx),
    addresses,
    defaultAddressId: defaultAddress?.id ?? null,
    deliveryOptions: defaultAddress ? listDeliveryOptions(defaultAddress, subtotalAfterDiscount).map((o) => serializeDeliveryOption(o, ctx)) : [],
    canCheckout: blockers.length === 0,
    blockers,
    holdMinutes: BUSINESS_RULES.checkoutHoldMinutes,
  };
}

export interface LegacyDeliveryInput {
  fullName: string;
  phone: string;
  addressLine1: string;
  addressLine2?: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  deliveryNote?: string;
}

/**
 * Compatibility for shop builds that still POST /checkout with an inline
 * `delivery` object (pre address-book). It now goes through the same safe
 * path as POST /orders: the address is validated and saved, standard
 * delivery is used, stock is reserved, and the cart is only cleared once
 * payment is verified. Remove once every deployed shop uses /orders.
 */
export async function legacyCheckout(userId: string, delivery: LegacyDeliveryInput | undefined, idempotencyKey: string, ctx: PricingContext) {
  if (!delivery) throw ApiError.unprocessable("A delivery address is required", undefined, "address_invalid");

  const parsed = createAddressSchema.safeParse({
    fullName: delivery.fullName,
    phone: delivery.phone,
    line1: delivery.addressLine1,
    line2: delivery.addressLine2,
    city: delivery.city,
    state: delivery.state,
    postalCode: delivery.postalCode,
    country: /^(in|india)$/i.test(delivery.country.trim()) ? "IN" : delivery.country,
  });
  if (!parsed.success) {
    throw ApiError.unprocessable("Please check your delivery address", { fieldErrors: parsed.error.flatten().fieldErrors }, "address_invalid");
  }

  const same = await prisma.address.findFirst({
    where: { userId, line1: parsed.data.line1, postalCode: parsed.data.postalCode, fullName: parsed.data.fullName },
  });
  const addressId = same?.id ?? (await createAddress(userId, parsed.data)).id;

  const { order } = await placeOrder(userId, { addressId, deliveryMethod: "standard" }, idempotencyKey, ctx, { createdVia: "shop-legacy" });
  if (order.status !== "pending_payment") return { order, payment: { id: null, status: "paid" } };

  const session = await createPaymentSession(order.id, userId);
  return {
    order,
    payment:
      session.gateway === "razorpay"
        ? { id: session.paymentId, status: "pending", razorpayOrderId: session.razorpayOrderId, razorpayKeyId: session.keyId, amount: session.amount, currency: session.currency }
        : { id: session.paymentId, status: "pending", clientSecret: session.clientSecret },
  };
}
