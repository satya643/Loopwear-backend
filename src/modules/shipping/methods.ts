import { BUSINESS_RULES } from "../../config/business";
import { ApiError } from "../../lib/errors";
import { INDIA_PIN_CODE } from "../../lib/indiaStates";
import { presentPricing, type PricingContext } from "../../lib/pricing";

/**
 * Delivery methods, fees, ETAs and serviceability. Pure over
 * BUSINESS_RULES.delivery so the shipping endpoint, the order preview and
 * order placement always agree on what a method costs and whether it's
 * available for an address.
 */

export interface DeliveryDestination {
  country: string;
  postalCode: string;
}

export interface DeliveryOption {
  code: string;
  label: string;
  description: string;
  /** What this order pays for delivery (0 once a free threshold is met). */
  feePaise: number;
  /** The method's list price, before any free-delivery threshold. */
  baseFeePaise: number;
  minDays: number;
  maxDays: number;
  estimatedFrom: Date;
  estimatedTo: Date;
  available: boolean;
  unavailableReason: string | null;
}

type MethodConfig = (typeof BUSINESS_RULES.delivery.methods)[number];

/** Deliveries run Monday–Saturday, so Sundays don't count towards an ETA. */
export function addDeliveryDays(from: Date, days: number): Date {
  const date = new Date(from);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    if (date.getDay() !== 0) added += 1;
  }
  return date;
}

export function checkServiceable(dest: DeliveryDestination): { ok: true } | { ok: false; reason: string } {
  if (!BUSINESS_RULES.delivery.serviceableCountries.includes(dest.country)) {
    return { ok: false, reason: "We currently deliver within India only" };
  }
  if (dest.country === "IN" && !INDIA_PIN_CODE.test(dest.postalCode)) {
    return { ok: false, reason: "Enter a valid 6-digit PIN code" };
  }
  return { ok: true };
}

function toOption(method: MethodConfig, dest: DeliveryDestination, subtotalAfterDiscountPaise: number, now: Date): DeliveryOption {
  const serviceable = checkServiceable(dest);
  let unavailableReason: string | null = null;
  if (!method.active) unavailableReason = `${method.label} is temporarily unavailable`;
  else if (!serviceable.ok) unavailableReason = serviceable.reason;
  else if (method.pincodePrefixes && !method.pincodePrefixes.some((prefix) => dest.postalCode.startsWith(prefix))) {
    unavailableReason = `${method.label} isn't available for PIN code ${dest.postalCode}`;
  }

  const free = method.freeAboveSubtotalPaise !== null && subtotalAfterDiscountPaise >= method.freeAboveSubtotalPaise;
  return {
    code: method.code,
    label: method.label,
    description: method.description,
    feePaise: free ? 0 : method.feePaise,
    baseFeePaise: method.feePaise,
    minDays: method.minDays,
    maxDays: method.maxDays,
    estimatedFrom: addDeliveryDays(now, method.minDays),
    estimatedTo: addDeliveryDays(now, method.maxDays),
    available: unavailableReason === null,
    unavailableReason,
  };
}

export function listDeliveryOptions(
  dest: DeliveryDestination,
  subtotalAfterDiscountPaise: number,
  now: Date = new Date()
): DeliveryOption[] {
  return BUSINESS_RULES.delivery.methods.map((m) => toOption(m, dest, subtotalAfterDiscountPaise, now));
}

/** The chosen method for this destination, or `delivery_unavailable` (422). */
export function resolveDeliveryOption(
  code: string,
  dest: DeliveryDestination,
  subtotalAfterDiscountPaise: number,
  now: Date = new Date()
): DeliveryOption {
  const method = BUSINESS_RULES.delivery.methods.find((m) => m.code === code);
  if (!method) {
    throw ApiError.unprocessable(`Unknown delivery method "${code}"`, { deliveryMethod: code }, "delivery_unavailable");
  }
  const option = toOption(method, dest, subtotalAfterDiscountPaise, now);
  if (!option.available) {
    throw ApiError.unprocessable(option.unavailableReason!, { deliveryMethod: code }, "delivery_unavailable");
  }
  return option;
}

export function serializeDeliveryOption(option: DeliveryOption, ctx: PricingContext) {
  return {
    code: option.code,
    label: option.label,
    description: option.description,
    minDays: option.minDays,
    maxDays: option.maxDays,
    estimatedFrom: option.estimatedFrom,
    estimatedTo: option.estimatedTo,
    available: option.available,
    unavailableReason: option.unavailableReason,
    pricing: presentPricing({ feePaise: option.feePaise, baseFeePaise: option.baseFeePaise }, ctx),
  };
}
