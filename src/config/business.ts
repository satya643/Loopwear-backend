/**
 * Business rules the frontend spec left undefined (build spec §8) or only
 * suggested defaults for. Centralized here so they're easy to find and tune
 * without hunting through service code.
 */
export const BUSINESS_RULES = {
  /**
   * §7.9 — deposit refund on return, keyed by the unit's condition at
   * inspection. `excellent`/`good` return the full deposit; `fair` withholds
   * a cleaning/wear surcharge; a unit that comes back needing more than a
   * wash (`needs_review`, or retired outright) forfeits the deposit to
   * cover replacement/repair cost. Confirm with finance before relying on
   * these numbers in production — they are reasonable defaults, not a
   * business-confirmed policy.
   */
  depositRefundPctByCondition: {
    excellent: 1,
    good: 1,
    fair: 0.5,
    needs_review: 0,
  } as Record<string, number>,
  depositForfeitPctIfRetired: 1,

  /**
   * §3 customers view / §8.4 — tier thresholds, using the spec's own
   * suggested default.
   */
  tiers: {
    signatureMinRentals: 10,
    signatureMinOnTimeRate: 0.9,
    memberMinRentals: 1,
  },

  /**
   * A returned unit isn't actually back on the rack the instant it's
   * returned — it still has to clear inspection/laundry/quality. Used by
   * the availability calculator to decide whether a unit currently mid-cycle
   * will be free again by a requested start date, since the frontend's
   * calendar has no real turnaround model to borrow from.
   */
  turnaroundBufferDays: 2,

  /**
   * Nothing anywhere ever created a DeliveryJob row — the console's Delivery
   * board (fully built for listing/reassigning/completing jobs) was
   * permanently empty on a fresh install. A dropoff job is now auto-created
   * when an order ships (console/orders/service.ts), with a delivery window
   * this many days out. No per-facility/zone routing model exists yet (only
   * a single seeded facility + no zone-matching logic), so `zone` is just
   * the order's delivery city — good enough for a single-facility operation,
   * a real gap once there's more than one.
   */
  defaultDeliveryWindowDays: 2,

  /**
   * Placing an order reserves a physical unit per item before the customer
   * reaches the payment screen (modules/orders/placement.ts) — inventory
   * has to be locked before money is taken. The order stays payable (the
   * customer can retry a failed payment) until `paymentExpiresAt`, this many
   * minutes after placement. After that jobs/releaseAbandonedReservations.ts
   * first asks the gateway whether it was actually paid, and only then
   * releases the units and closes the order. The cart is never touched
   * until payment is confirmed.
   */
  checkoutHoldMinutes: 30,

  /** How often the in-process scheduler runs the release/reconcile job. */
  releaseJobIntervalMinutes: 5,

  cart: {
    maxQuantityPerLine: 5,
    maxLines: 20,
  },

  /**
   * Delivery methods offered at checkout. Config rather than a table until
   * ops needs to edit them from the console. Fees are base-currency paise.
   * `pincodePrefixes: null` means the method is offered at every
   * serviceable PIN code; a list restricts it (e.g. express to metros).
   * `freeAboveSubtotalPaise` waives the fee once the discounted subtotal
   * reaches it (null = never free).
   */
  delivery: {
    serviceableCountries: ["IN"],
    methods: [
      {
        code: "standard",
        label: "Standard delivery",
        description: "Delivered in 3–5 business days",
        feePaise: 5000,
        minDays: 3,
        maxDays: 5,
        freeAboveSubtotalPaise: null as number | null,
        pincodePrefixes: null as string[] | null,
        active: true,
      },
      {
        code: "express",
        label: "Express delivery",
        description: "Delivered in 1–2 business days",
        feePaise: 10000,
        minDays: 1,
        maxDays: 2,
        freeAboveSubtotalPaise: null as number | null,
        pincodePrefixes: null as string[] | null,
        active: true,
      },
    ],
  },
};
