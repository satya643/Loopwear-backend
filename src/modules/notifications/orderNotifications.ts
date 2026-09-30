import type { NotificationSeverity } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { sendEmail } from "../auth/email";
import { sendSms } from "../auth/sms";

function inr(paise: number) {
  return `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/**
 * Customer confirmation once payment is verified. Strictly best-effort: it
 * runs after the payment transaction has committed and every failure is
 * swallowed — a flaky email/SMS provider must never undo or block a paid
 * order.
 */
export async function sendOrderConfirmation(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: { select: { name: true, email: true, phone: true } }, items: { select: { productName: true } } },
    });
    if (!order) return;

    const charged = order.totalPaise + order.depositTotalPaise;
    const itemCount = order.items.length;
    const link = `${env.frontendBaseUrl}/orders/${order.id}`;
    const email = order.deliveryEmail ?? order.customer.email;
    const phone = order.deliveryPhone ?? order.customer.phone;

    const lines = [
      `Hi ${order.customer.name},`,
      "",
      `Your order ${order.id} is confirmed — ${itemCount} item${itemCount === 1 ? "" : "s"}, ${inr(charged)} paid.`,
    ];
    if (order.deliveryMethodLabel) {
      lines.push(`Delivery: ${order.deliveryMethodLabel} to ${order.deliveryAddressLine1}, ${order.city} ${order.deliveryPostalCode}.`);
    }
    lines.push(`Track it here: ${link}`);
    const text = lines.join("\n");

    await Promise.allSettled([
      email ? sendEmail(email, `Order ${order.id} confirmed`, text) : Promise.resolve(),
      phone ? sendSms(phone, `LoopWear: order ${order.id} confirmed (${inr(charged)} paid). Track: ${link}`) : Promise.resolve(),
    ]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`sendOrderConfirmation(${orderId}) failed:`, err);
  }
}

/** Raises something for the console's notifications feed (refund failures, amount mismatches…). */
export async function notifyOps(severity: NotificationSeverity, title: string, detail: string, orderId: string): Promise<void> {
  try {
    await prisma.notification.create({ data: { severity, title, detail, relatedType: "order", relatedId: orderId } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("notifyOps failed:", err);
  }
}
