/**
 * Prisma Client returns enum members by their code identifier (e.g.
 * "DateNight"), not the @map'd DB label ("Date Night"). These maps translate
 * back to the display strings the frontend spec's enums actually use.
 */
export const OCCASION_LABELS: Record<string, string> = {
  Wedding: "Wedding",
  Party: "Party",
  Office: "Office",
  DateNight: "Date Night",
  Festival: "Festival",
  Travel: "Travel",
  Everyday: "Everyday",
};

export const CONDITION_LABELS: Record<string, string> = {
  excellent: "excellent",
  good: "good",
  fair: "fair",
  needs_review: "needs review",
};

export const ORDER_STATUS_LABELS: Record<string, string> = {
  pending_payment: "pending payment",
  confirmed: "confirmed",
  packed: "packed",
  shipped: "shipped",
  with_customer: "with customer",
  return_in_transit: "return in transit",
  closed: "closed",
  cancelled: "cancelled",
};

export function occasionCodeFromLabel(label: string): string | undefined {
  return Object.entries(OCCASION_LABELS).find(([, v]) => v === label)?.[0];
}
