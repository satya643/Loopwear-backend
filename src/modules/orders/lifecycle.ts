import type { OrderActor, Prisma } from "@prisma/client";
import { recordOrderEvent } from "./events";
import { releaseOrderInventory } from "./inventory";

type Tx = Prisma.TransactionClient;

/**
 * Closes an order that was never paid: `pending_payment` → cancelled /
 * payment_failed, releasing the units it held and failing its open gateway
 * payment. The status change is a guarded UPDATE … WHERE status =
 * 'pending_payment', so concurrent callers (customer cancel, the expiry
 * job, a newer checkout superseding it) can't both release it; the loser
 * gets `false` and does nothing.
 *
 * A payment that still arrives afterwards is handled by
 * payments/finalize.ts (re-reserve the same units, or refund).
 */
export async function closeUnpaidOrder(
  tx: Tx,
  orderId: string,
  opts: {
    status: "cancelled" | "payment_failed";
    eventType: "order_cancelled" | "order_expired";
    reason: string;
    actor: OrderActor;
    actorUserId?: string;
  }
): Promise<boolean> {
  const now = new Date();
  const closed = await tx.order.updateMany({
    where: { id: orderId, status: "pending_payment" },
    data: { status: opts.status, cancelledAt: now, cancelReason: opts.reason },
  });
  if (closed.count === 0) return false;

  await releaseOrderInventory(tx, orderId, `Released: ${opts.reason}`, opts.actorUserId);
  await tx.payment.updateMany({
    where: { orderId, status: "pending" },
    data: { status: "failed", failureReason: opts.reason },
  });
  await recordOrderEvent(tx, {
    orderId,
    type: opts.eventType,
    status: opts.status,
    message: opts.reason,
    actor: opts.actor,
    actorUserId: opts.actorUserId,
  });
  return true;
}
