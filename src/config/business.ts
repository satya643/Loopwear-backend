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
};
