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
   * A checkout reserves garment units and clears the cart as soon as the
   * Order row commits — *before* payment is confirmed (see
   * modules/checkout/service.ts). If the customer abandons checkout (closes
   * the tab, payment never completes, no webhook fires), nothing previously
   * released that reservation: the order sat in `pending_payment` and its
   * units stayed `reserved` forever, invisible/unbookable to everyone else.
   * jobs/releaseStalePendingOrders.ts cancels orders past this age with no
   * paid payment and releases their units back to `available`.
   *
   * NOTE: overlaps with checkoutHoldMinutes / releaseAbandonedReservations.ts
   * below — two independent implementations of the same release job landed
   * from different branches during a merge. Needs consolidating.
   */
  pendingPaymentReleaseMinutes: 60,

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
   * Checkout reserves a physical unit for every cart line the instant an
   * order is created — necessarily, since inventory has to be locked before
   * the customer even reaches the payment screen (see
   * modules/checkout/service.ts). If they never complete payment (widget
   * closed, card declined, tab abandoned), that reservation used to hold
   * the unit forever — a `pending_payment` order older than this many
   * minutes is treated as abandoned and released (see
   * jobs/releaseAbandonedReservations.ts): the unit goes back to
   * `available`, its order to `cancelled`, its payment (if any) to
   * `failed`. 30 minutes is a common checkout-hold window for this kind of
   * store; tune freely.
   */
  checkoutHoldMinutes: 30,
};
