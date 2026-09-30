import { runReleaseAbandonedReservationsJob } from "./releaseAbandonedReservations";

/**
 * Kept so `npm run jobs:release-stale-orders` keeps working. This used to be
 * a second, independent implementation of the same release job (merged in
 * from another branch); both now run the single consolidated job in
 * ./releaseAbandonedReservations.ts.
 */
export const runReleaseStalePendingOrdersJob = runReleaseAbandonedReservationsJob;

if (require.main === module) {
  runReleaseAbandonedReservationsJob()
    .then((r) => {
      // eslint-disable-next-line no-console
      console.log(`Checked ${r.checked} unpaid order(s): released ${r.released}, confirmed ${r.confirmed} after reconciling`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
