import { prisma } from "../lib/prisma";

/**
 * Nightly aggregation job (build spec §3 `analytics`): materializes the
 * Concourse's four sparkline metrics into daily_metrics rows instead of
 * hand-maintaining them, as the frontend mock data did. Run via
 * `npm run jobs:daily-metrics` on a schedule (cron/CI scheduler — this repo
 * doesn't assume any particular scheduler infra).
 */

function startOfDay(d: Date): Date {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

async function computeUtilization(): Promise<number> {
  const total = await prisma.garmentUnit.count({ where: { stage: { notIn: ["retired", "sold"] } } });
  if (total === 0) return 0;
  const inUse = await prisma.garmentUnit.count({ where: { stage: { in: ["reserved", "rented"] } } });
  return inUse / total;
}

async function computeRevenue(date: Date): Promise<number> {
  const start = startOfDay(date);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  const result = await prisma.payment.aggregate({
    where: { status: "paid", createdAt: { gte: start, lt: end } },
    _sum: { amountPaise: true },
  });
  return (result._sum.amountPaise ?? 0) / 100;
}

async function computeTurnaroundDays(date: Date): Promise<number> {
  const start = startOfDay(date);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const completions = await prisma.stageTransition.findMany({
    where: { toStage: "available", occurredAt: { gte: start, lt: end } },
    select: { garmentUnitId: true, occurredAt: true },
  });
  if (completions.length === 0) return 0;

  let totalDays = 0;
  let counted = 0;
  for (const completion of completions) {
    const returnedAt = await prisma.stageTransition.findFirst({
      where: { garmentUnitId: completion.garmentUnitId, toStage: "returned", occurredAt: { lt: completion.occurredAt } },
      orderBy: { occurredAt: "desc" },
    });
    if (!returnedAt) continue;
    totalDays += (completion.occurredAt.getTime() - returnedAt.occurredAt.getTime()) / (24 * 60 * 60 * 1000);
    counted += 1;
  }
  return counted > 0 ? totalDays / counted : 0;
}

async function computeOverdueCount(): Promise<number> {
  return prisma.orderItem.count({
    where: { mode: "rent", actualReturnDate: null, rentReturnDate: { lt: new Date() } },
  });
}

export async function runDailyMetricsJob(forDate: Date = new Date()) {
  const date = startOfDay(forDate);
  const [utilization, revenue, turnaround, overdue] = await Promise.all([
    computeUtilization(),
    computeRevenue(date),
    computeTurnaroundDays(date),
    computeOverdueCount(),
  ]);

  await prisma.$transaction([
    prisma.dailyMetric.upsert({
      where: { date_metricName: { date, metricName: "utilization" } },
      update: { value: utilization },
      create: { date, metricName: "utilization", value: utilization },
    }),
    prisma.dailyMetric.upsert({
      where: { date_metricName: { date, metricName: "revenue" } },
      update: { value: revenue },
      create: { date, metricName: "revenue", value: revenue },
    }),
    prisma.dailyMetric.upsert({
      where: { date_metricName: { date, metricName: "turnaround" } },
      update: { value: turnaround },
      create: { date, metricName: "turnaround", value: turnaround },
    }),
    prisma.dailyMetric.upsert({
      where: { date_metricName: { date, metricName: "overdue" } },
      update: { value: overdue },
      create: { date, metricName: "overdue", value: overdue },
    }),
  ]);
}

if (require.main === module) {
  runDailyMetricsJob()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log("Daily metrics computed");
      process.exit(0);
    })
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      process.exit(1);
    });
}
