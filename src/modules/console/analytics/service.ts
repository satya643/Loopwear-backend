import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";

const METRICS = ["utilization", "revenue", "turnaround", "overdue"] as const;
type Metric = (typeof METRICS)[number];

const METRIC_LABEL: Record<Metric, string> = {
  utilization: "Utilization",
  revenue: "Revenue",
  turnaround: "Turnaround time",
  overdue: "Overdue rentals",
};

/**
 * Reads the last 12 points a nightly job (jobs/dailyMetrics.ts) materialized
 * into daily_metrics, per build spec §3 ("do not store this as a table" of
 * hand-typed numbers — compute and cache instead). Narrative is a plain
 * template comparing the latest point to 7 days prior; deliberately not
 * generating a causal claim ("driven by outerwear demand") since nothing in
 * this data actually supports attributing the change to a cause.
 */
export async function getMetricSeries(metric: string) {
  if (!METRICS.includes(metric as Metric)) throw ApiError.badRequest(`Unknown metric "${metric}"`);

  const rows = await prisma.dailyMetric.findMany({
    where: { metricName: metric },
    orderBy: { date: "desc" },
    take: 12,
  });
  const series = rows.reverse().map((r) => ({ date: r.date, value: r.value }));

  let narrative = "Not enough data yet to compare.";
  if (series.length >= 2) {
    const latest = series[series.length - 1].value;
    const weekAgoIndex = Math.max(0, series.length - 8);
    const reference = series[weekAgoIndex].value;
    if (reference !== 0) {
      const pct = Math.round(((latest - reference) / Math.abs(reference)) * 100);
      const direction = pct >= 0 ? "up" : "down";
      narrative = `${METRIC_LABEL[metric as Metric]} is ${direction} ${Math.abs(pct)}% compared to a week ago.`;
    }
  }

  return { metric, label: METRIC_LABEL[metric as Metric], series, narrative };
}
