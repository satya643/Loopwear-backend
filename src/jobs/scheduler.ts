import { BUSINESS_RULES } from "../config/business";
import { runReleaseAbandonedReservationsJob } from "./releaseAbandonedReservations";

/**
 * Runs the unpaid-order release/reconcile job inside the API process —
 * without it, abandoned checkouts would hold stock until someone ran the
 * job by hand. Skips a tick if the previous run is still going. The job is
 * idempotent, so running it on several instances is safe.
 */
export function startJobScheduler() {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runReleaseAbandonedReservationsJob();
      if (r.released > 0 || r.confirmed > 0) {
        // eslint-disable-next-line no-console
        console.log(`[jobs] unpaid orders: released ${r.released}, confirmed ${r.confirmed}`);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[jobs] release/reconcile run failed:", err);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, BUSINESS_RULES.releaseJobIntervalMinutes * 60 * 1000);
  timer.unref();
  void tick();
  return () => clearInterval(timer);
}
