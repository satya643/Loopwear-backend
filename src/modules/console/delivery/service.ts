import { prisma } from "../../../lib/prisma";
import { ApiError } from "../../../lib/errors";
import { paginatedResponse, type Pagination } from "../../../lib/pagination";

/**
 * `delayed` is derived at read time from window_end vs now, not a value an
 * operator sets by hand (build spec §7.10 — the frontend had exactly one
 * hardcoded "delayed" mock row with no logic behind it). jobs/delayedDeliveries.ts
 * additionally persists the flip periodically so list queries that filter by
 * stored status stay accurate between reads.
 */
function presentStatus(job: { status: string; windowEnd: Date }): string {
  if (job.status === "completed") return "completed";
  if (new Date() > job.windowEnd) return "delayed";
  return job.status;
}

function serialize(job: any) {
  return {
    id: job.id,
    type: job.type,
    orderId: job.orderId,
    customer: job.order?.customer?.name,
    window: `${job.windowStart.toISOString()} – ${job.windowEnd.toISOString()}`,
    windowStart: job.windowStart,
    windowEnd: job.windowEnd,
    zone: job.zone,
    courier: job.courier ? { id: job.courier.id, name: job.courier.name } : null,
    status: presentStatus(job),
  };
}

export async function listDeliveryJobs(filters: { status?: string; type?: string }, pagination: Pagination) {
  const where: import("@prisma/client").Prisma.DeliveryJobWhereInput = {};
  if (filters.type) where.type = filters.type as never;
  // `delayed` isn't filterable directly in SQL since it's derived; fetch
  // broadly, filter in memory when that specific status is requested, THEN
  // paginate the filtered result — pagination must come after the derived
  // filter or `total`/page slicing would be wrong relative to what's shown.
  const jobs = await prisma.deliveryJob.findMany({
    where,
    include: { order: { include: { customer: { select: { name: true } } } }, courier: true },
    orderBy: { windowStart: "asc" },
  });
  let serialized = jobs.map(serialize);
  if (filters.status) serialized = serialized.filter((j) => j.status === filters.status);

  const total = serialized.length;
  const { skip, take } = { skip: (pagination.page - 1) * pagination.pageSize, take: pagination.pageSize };
  return paginatedResponse(serialized.slice(skip, skip + take), total, pagination);
}

export async function reassignCourier(jobId: string, courierId: string) {
  const job = await prisma.deliveryJob.findUnique({ where: { id: jobId } });
  if (!job) throw ApiError.notFound("Delivery job not found");
  const courier = await prisma.courier.findUnique({ where: { id: courierId } });
  if (!courier) throw ApiError.notFound("Courier not found");

  const updated = await prisma.deliveryJob.update({
    where: { id: jobId },
    data: { courierId },
    include: { order: { include: { customer: { select: { name: true } } } }, courier: true },
  });
  return serialize(updated);
}

export async function markComplete(jobId: string) {
  const job = await prisma.deliveryJob.findUnique({ where: { id: jobId } });
  if (!job) throw ApiError.notFound("Delivery job not found");
  if (job.status === "completed") return job;

  const updated = await prisma.deliveryJob.update({
    where: { id: jobId },
    data: { status: "completed" },
    include: { order: { include: { customer: { select: { name: true } } } }, courier: true },
  });
  return serialize(updated);
}
