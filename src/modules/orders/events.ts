import type { OrderActor, OrderEventType, OrderStatus, Prisma, PrismaClient } from "@prisma/client";

type Client = PrismaClient | Prisma.TransactionClient;

export interface OrderEventInput {
  orderId: string;
  type: OrderEventType;
  /** The order's status after this event, if the event changed it. */
  status?: OrderStatus;
  message: string;
  actor: OrderActor;
  actorUserId?: string | null;
  metadata?: Prisma.InputJsonValue;
}

/** Append-only; call it inside the same transaction as the change it records. */
export function recordOrderEvent(client: Client, event: OrderEventInput) {
  return client.orderEvent.create({
    data: {
      orderId: event.orderId,
      type: event.type,
      status: event.status,
      message: event.message,
      actor: event.actor,
      actorUserId: event.actorUserId ?? undefined,
      metadata: event.metadata,
    },
  });
}
