import type { Order, OrderEvent, OrderStatus } from "@prisma/client";

/** What a customer sees for each status (ops labels live in lib/enumLabels). */
export const CUSTOMER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending_payment: "Awaiting payment",
  confirmed: "Order placed",
  packed: "Packed",
  shipped: "Out for delivery",
  with_customer: "Delivered",
  return_in_transit: "Return in transit",
  closed: "Completed",
  cancelled: "Cancelled",
  payment_failed: "Payment failed",
  refunded: "Refunded",
};

const STEP_DESCRIPTIONS: Partial<Record<OrderStatus, string>> = {
  confirmed: "Payment received, your order is confirmed.",
  packed: "Your items are packed and ready to ship.",
  shipped: "Your order is on its way.",
  with_customer: "Delivered to you.",
  return_in_transit: "Your rental is on its way back to us.",
  closed: "All done — thanks for choosing LoopWear.",
};

const TERMINAL: OrderStatus[] = ["cancelled", "payment_failed", "refunded"];

export interface TimelineStep {
  key: OrderStatus;
  label: string;
  description: string;
  state: "done" | "current" | "upcoming";
  at: Date | null;
}

/**
 * Progress steps for the tracking page, with real timestamps from the
 * order's events. Rentals get the return leg; purchases end at delivery.
 */
export function buildTimeline(order: Pick<Order, "status" | "confirmedAt">, events: OrderEvent[], hasRentals: boolean) {
  const flow: OrderStatus[] = ["confirmed", "packed", "shipped", "with_customer", ...(hasRentals ? (["return_in_transit", "closed"] as OrderStatus[]) : [])];
  const reachedAt = new Map<OrderStatus, Date>();
  for (const e of [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    if (e.status && !reachedAt.has(e.status)) reachedAt.set(e.status, e.createdAt);
  }
  if (order.confirmedAt && !reachedAt.has("confirmed")) reachedAt.set("confirmed", order.confirmedAt);

  // A buy-only order that ops closed counts as delivered.
  const effective: OrderStatus = !hasRentals && (order.status === "closed" || order.status === "return_in_transit") ? "with_customer" : order.status;
  const currentIndex = flow.indexOf(effective);

  const steps: TimelineStep[] = flow.map((key, i) => ({
    key,
    label: CUSTOMER_STATUS_LABELS[key],
    description: STEP_DESCRIPTIONS[key] ?? "",
    state: currentIndex === -1 ? (reachedAt.has(key) ? "done" : "upcoming") : i < currentIndex ? "done" : i === currentIndex ? "current" : "upcoming",
    at: reachedAt.get(key) ?? null,
  }));
  // The last step is "done", not "current", once it's been reached.
  if (currentIndex === flow.length - 1) steps[currentIndex].state = "done";

  const terminalEvent = TERMINAL.includes(order.status)
    ? [...events].reverse().find((e) => e.status === order.status)
    : undefined;

  return {
    steps,
    terminal: TERMINAL.includes(order.status)
      ? { status: order.status, label: CUSTOMER_STATUS_LABELS[order.status], at: terminalEvent?.createdAt ?? null, message: terminalEvent?.message ?? null }
      : null,
    awaitingPayment: order.status === "pending_payment",
    events: events
      .filter((e) => e.type !== "note" || e.actor !== "operator")
      .map((e) => ({ id: e.id, type: e.type, status: e.status, message: e.message, at: e.createdAt })),
  };
}
