import { prisma } from "../lib/prisma";

/**
 * Persists the delayed-status flip for delivery_jobs whose window has
 * passed without completion. The API also computes this live at read time
 * (see console/delivery/service.ts) so correctness never depends on this
 * job's schedule — this just keeps stored `status` values (and any query
 * that filters on it directly) in sync too.
 */
export async function runDelayedDeliveriesJob() {
  const overdue = await prisma.deliveryJob.findMany({
    where: { status: { in: ["scheduled", "en_route"] }, windowEnd: { lt: new Date() } },
  });
  if (overdue.length === 0) return 0;

  await prisma.deliveryJob.updateMany({
    where: { id: { in: overdue.map((j) => j.id) } },
    data: { status: "delayed" },
  });
  return overdue.length;
}

if (require.main === module) {
  runDelayedDeliveriesJob()
    .then((n) => {
      // eslint-disable-next-line no-console
      console.log(`Marked ${n} delivery job(s) delayed`);
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
