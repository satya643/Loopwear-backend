import crypto from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only Razorpay's network calls are faked; signature checks stay real.
const rp = vi.hoisted(() => ({
  createRazorpayOrder: vi.fn(),
  fetchRazorpayPayment: vi.fn(),
  captureRazorpayPayment: vi.fn(),
  fetchRazorpayOrderPayments: vi.fn(),
  createRazorpayRefund: vi.fn(),
}));
vi.mock("../payments/razorpay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../payments/razorpay")>();
  return { ...actual, ...rp, isRazorpayConfigured: () => true };
});

import { createApp } from "../../app";
import { prisma } from "../../lib/prisma";
import { signSessionToken } from "../../lib/jwt";
import { runReleaseAbandonedReservationsJob } from "../../jobs/releaseAbandonedReservations";

const KEY_SECRET = "integration_key_secret";
const WEBHOOK_SECRET = "integration_webhook_secret";

let server: Server;
let base: string;
let seq = 0;

type Json = Record<string, any>;

async function api(method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as Json };
}

async function makeUser(label: string) {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      name: `${label} Tester`,
      email: `${label.toLowerCase()}-${seq}-${Date.now()}@test.dev`,
      phone: `+9198${String(Date.now() + seq).slice(-8)}`,
      verified: true,
      country: "IN",
    },
  });
  const session = await prisma.session.create({ data: { userId: user.id, expiresAt: new Date(Date.now() + 86_400_000) } });
  return { user, token: signSessionToken({ sub: user.id, sessionId: session.id, role: user.role }) };
}

async function makeProduct(opts: { units?: number; buyPricePaise?: number; rentPricePaise?: number; depositPaise?: number } = {}) {
  seq += 1;
  const category = await prisma.category.upsert({ where: { slug: "dresses" }, update: {}, create: { name: "Dresses", slug: "dresses" } });
  const product = await prisma.product.create({
    data: {
      name: `Linen Dress ${seq}`,
      brand: "LoopWear",
      categoryId: category.id,
      occasions: ["Party"],
      styles: ["Classic"],
      rentPricePaise: opts.rentPricePaise ?? 50_000,
      rentDays: 4,
      buyPricePaise: opts.buyPricePaise ?? 200_000,
      depositPaise: opts.depositPaise ?? 100_000,
      deliveryDays: 3,
      fabric: "Linen",
      care: ["Dry clean"],
      measurements: [],
      variants: { create: [{ color: "Black", colorHex: "#000000", views: ["front"], imageUrls: {}, sizes: { create: [{ size: "M" }] } }] },
    },
    include: { variants: true },
  });
  const variant = product.variants[0];
  const unitCount = opts.units ?? 1;
  for (let i = 0; i < unitCount; i++) {
    await prisma.garmentUnit.create({ data: { sku: `SKU-${seq}-${i}-${Date.now()}`, variantId: variant.id, size: "M" } });
  }
  return { product, variant };
}

async function makeAddress(token: string) {
  const res = await api("POST", "/addresses", {
    token,
    body: { fullName: "Asha Rao", phone: "9876543210", line1: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: "560001" },
  });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addToCart(token: string, product: { id: string }, variant: { id: string }, extra: Json = {}) {
  return api("POST", "/cart/items", { token, body: { productId: product.id, variantId: variant.id, size: "M", mode: "buy", quantity: 1, ...extra } });
}

/** Cart → address → preview → place. Returns the placed order response. */
async function checkout(token: string, key: string = crypto.randomUUID()) {
  const addressId = await makeAddress(token);
  const preview = await api("POST", "/orders/preview", { token, body: { addressId, deliveryMethod: "standard" } });
  expect(preview.status).toBe(200);
  const placed = await api("POST", "/orders", {
    token,
    headers: { "Idempotency-Key": key },
    body: { addressId, deliveryMethod: "standard", expectedTotalPaise: preview.body.expectedTotalPaise },
  });
  return { placed, preview, addressId };
}

function checkoutSignature(orderId: string, paymentId: string) {
  return crypto.createHmac("sha256", KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
}

async function sendWebhook(event: Json, eventId: string = crypto.randomUUID()) {
  const raw = JSON.stringify(event);
  return api("POST", "/webhooks/razorpay", {
    body: raw,
    headers: {
      "x-razorpay-signature": crypto.createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex"),
      "x-razorpay-event-id": eventId,
    },
  });
}

function capturedEvent(razorpayOrderId: string, paymentId: string, amount: number) {
  return {
    event: "payment.captured",
    payload: { payment: { entity: { id: paymentId, order_id: razorpayOrderId, amount, currency: "INR", status: "captured", method: "upi" } } },
  };
}

async function unitStages(variantId: string) {
  return (await prisma.garmentUnit.findMany({ where: { variantId }, orderBy: { sku: "asc" } })).map((u) => u.stage);
}

async function eventTypes(orderId: string) {
  return (await prisma.orderEvent.findMany({ where: { orderId }, orderBy: { createdAt: "asc" } })).map((e) => e.type);
}

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

beforeEach(async () => {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  await prisma.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t.tablename}"`).join(", ")} CASCADE`);
  vi.clearAllMocks();
  let n = 0;
  rp.createRazorpayOrder.mockImplementation(async (amount: number, currency: string) => ({ id: `order_rzp_${++n}`, amount, currency }));
  rp.fetchRazorpayOrderPayments.mockResolvedValue([]);
  rp.createRazorpayRefund.mockImplementation(async () => ({ id: `rfnd_${++n}`, status: "processed" }));
});

describe("cart", () => {
  it("validates product, colour/size and stock on add, and flags items that later become unavailable", async () => {
    const { token } = await makeUser("Cart");
    const { product, variant } = await makeProduct({ units: 1 });

    const tooMany = await addToCart(token, product, variant, { quantity: 2 });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.code).toBe("out_of_stock");
    expect(tooMany.body.error.details.available).toBe(1);

    const wrongSize = await addToCart(token, product, variant, { size: "XL" });
    expect(wrongSize.body.error.code).toBe("variant_unavailable");

    const ok = await addToCart(token, product, variant);
    expect(ok.status).toBe(201);
    expect(ok.body.items[0]).toMatchObject({ quantity: 1, status: "ok", variantId: variant.id });
    expect(ok.body.summary.base.subtotalPaise).toBe(200_000);

    const again = await addToCart(token, product, variant);
    expect(again.body.error.code).toBe("out_of_stock");

    await prisma.product.update({ where: { id: product.id }, data: { isActive: false } });
    const cart = await api("GET", "/cart", { token });
    expect(cart.body.items[0].status).toBe("blocked");
    expect(cart.body.items[0].issues[0].code).toBe("product_unavailable");
    expect(cart.body.canCheckout).toBe(false);
    expect((await addToCart(token, product, variant)).body.error.code).toBe("product_unavailable");
  });

  it("merges a guest cart after sign-in and reports what couldn't be added", async () => {
    const { token } = await makeUser("Merge");
    const inStock = await makeProduct({ units: 2 });
    const soldOut = await makeProduct({ units: 0 });
    const res = await api("POST", "/cart/merge", {
      token,
      body: {
        lines: [
          // no variantId: an older guest cart — the backend picks the colour
          { productId: inStock.product.id, mode: "buy", size: "M", quantity: 5 },
          { productId: soldOut.product.id, variantId: soldOut.variant.id, mode: "buy", size: "M", quantity: 1 },
        ],
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.merge.merged).toBe(1);
    expect(res.body.merge.reduced[0].quantity).toBe(2);
    expect(res.body.merge.dropped[0]).toMatchObject({ productId: soldOut.product.id, reason: "out_of_stock" });
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].variantId).toBe(inStock.variant.id);
  });
});

describe("checkout gate, addresses and delivery", () => {
  it("rejects guests, invalid addresses, other users' addresses and unavailable delivery methods", async () => {
    expect((await api("GET", "/checkout")).status).toBe(401);

    const { token } = await makeUser("Addr");
    const bad = await api("POST", "/addresses", {
      token,
      body: { fullName: "A R", phone: "9876543210", line1: "12 MG Road", city: "Bengaluru", state: "Karnataka", postalCode: "56001" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fieldErrors.postalCode).toBeDefined();

    const { product, variant } = await makeProduct();
    await addToCart(token, product, variant);
    const addressId = await makeAddress(token);

    const drone = await api("POST", "/orders/preview", { token, body: { addressId, deliveryMethod: "drone" } });
    expect(drone.status).toBe(422);
    expect(drone.body.error.code).toBe("delivery_unavailable");

    const other = await makeUser("Other");
    await addToCart(other.token, product, variant);
    const foreign = await api("POST", "/orders/preview", { token: other.token, body: { addressId, deliveryMethod: "standard" } });
    expect(foreign.status).toBe(404);

    const gate = await api("GET", "/checkout", { token });
    expect(gate.status).toBe(200);
    expect(gate.body).toMatchObject({ canCheckout: true, defaultAddressId: addressId });
    expect(gate.body.deliveryOptions.map((o: Json) => o.code)).toEqual(["standard", "express"]);
  });
});

describe("placing and paying for an order", () => {
  it("happy path: coupon + delivery fee computed server-side, cart kept until payment is verified, then confirmed", async () => {
    const { user, token } = await makeUser("Happy");
    const { product, variant } = await makeProduct({ units: 2, buyPricePaise: 200_000 });
    await prisma.coupon.create({ data: { code: "WELCOME10", type: "percent", value: 10 } });

    await addToCart(token, product, variant);
    const withCoupon = await api("POST", "/cart/coupon", { token, body: { code: "welcome10" } });
    expect(withCoupon.body.summary.base.discountPaise).toBe(20_000);

    const { placed, preview } = await checkout(token);
    expect(preview.body.pricing.base).toMatchObject({ subtotalPaise: 200_000, discountPaise: 20_000, deliveryFeePaise: 5_000, grandTotalPaise: 185_000 });
    expect(placed.status).toBe(201);
    expect(placed.body.order.status).toBe("pending_payment");
    expect(placed.body.payment).toMatchObject({ gateway: "razorpay", razorpayOrderId: "order_rzp_1", amount: 185_000, currency: "INR" });

    const orderId = placed.body.order.id;
    // Not cleared yet — only a verified payment does that.
    expect((await api("GET", "/cart", { token })).body.items).toHaveLength(1);
    expect(await unitStages(variant.id)).toContain("reserved");

    rp.fetchRazorpayPayment.mockResolvedValue({ id: "pay_1", order_id: "order_rzp_1", status: "captured", amount: 185_000, currency: "INR", method: "upi" });
    const verified = await api("POST", "/payments/razorpay/verify", {
      token,
      body: { razorpay_order_id: "order_rzp_1", razorpay_payment_id: "pay_1", razorpay_signature: checkoutSignature("order_rzp_1", "pay_1") },
    });
    expect(verified.status).toBe(200);
    expect(verified.body).toMatchObject({ status: "confirmed", order: { id: orderId, status: "confirmed" } });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, items: true } });
    expect(order.status).toBe("confirmed");
    expect(order.payments[0]).toMatchObject({ status: "paid", method: "upi", gatewayPaymentRef: "pay_1" });
    expect(order.items[0]).toMatchObject({ productName: product.name, color: "Black", unitPricePaise: 200_000 });
    expect((await unitStages(variant.id)).filter((s) => s === "sold")).toHaveLength(1);
    expect((await api("GET", "/cart", { token })).body.items).toHaveLength(0);
    expect(await prisma.couponRedemption.count({ where: { userId: user.id } })).toBe(1);
    expect(await eventTypes(orderId)).toEqual(["order_created", "payment_initiated", "payment_succeeded"]);

    const again = await api("POST", "/payments/razorpay/verify", {
      token,
      body: { razorpay_order_id: "order_rzp_1", razorpay_payment_id: "pay_1", razorpay_signature: checkoutSignature("order_rzp_1", "pay_1") },
    });
    expect(again.body.status).toBe("already_processed");

    const tracking = await api("GET", `/orders/${orderId}/status`, { token });
    expect(tracking.body.timeline.steps[0]).toMatchObject({ key: "confirmed", state: "current" });
    expect(tracking.body.timeline.steps.map((s: Json) => s.key)).toEqual(["confirmed", "packed", "shipped", "with_customer"]);
  });

  it("rejects a forged signature and payments belonging to someone else", async () => {
    const owner = await makeUser("Owner");
    const intruder = await makeUser("Intruder");
    const { product, variant } = await makeProduct();
    await addToCart(owner.token, product, variant);
    const { placed } = await checkout(owner.token);

    const forged = await api("POST", "/payments/razorpay/verify", {
      token: owner.token,
      body: { razorpay_order_id: "order_rzp_1", razorpay_payment_id: "pay_1", razorpay_signature: "deadbeef" },
    });
    expect(forged.body.error.code).toBe("payment_verification_failed");

    const stolen = await api("POST", "/payments/razorpay/verify", {
      token: intruder.token,
      body: { razorpay_order_id: "order_rzp_1", razorpay_payment_id: "pay_1", razorpay_signature: checkoutSignature("order_rzp_1", "pay_1") },
    });
    expect(stolen.status).toBe(404);
    expect((await api("GET", `/orders/${placed.body.order.id}`, { token: intruder.token })).status).toBe(404);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.body.order.id } })).status).toBe("pending_payment");
  });

  it("refuses to place the order if the price changed after review — nothing is created and the cart is untouched", async () => {
    const { token } = await makeUser("Price");
    const { product, variant } = await makeProduct();
    await addToCart(token, product, variant);
    const addressId = await makeAddress(token);
    const preview = await api("POST", "/orders/preview", { token, body: { addressId, deliveryMethod: "standard" } });

    await prisma.product.update({ where: { id: product.id }, data: { buyPricePaise: 250_000 } });
    const placed = await api("POST", "/orders", {
      token,
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: { addressId, deliveryMethod: "standard", expectedTotalPaise: preview.body.expectedTotalPaise },
    });
    expect(placed.status).toBe(409);
    expect(placed.body.error.code).toBe("price_changed");
    expect(placed.body.error.details.currentTotalPaise).toBe(255_000);
    expect(await prisma.order.count()).toBe(0);
    expect(await unitStages(variant.id)).toEqual(["available"]);
    expect((await api("GET", "/cart", { token })).body.items).toHaveLength(1);
  });

  it("is idempotent: same key or an identical re-submit returns the same order and gateway order", async () => {
    const { token } = await makeUser("Idem");
    const { product, variant } = await makeProduct({ units: 3 });
    await addToCart(token, product, variant);
    const key = crypto.randomUUID();
    const { placed, addressId, preview } = await checkout(token, key);

    const replay = await api("POST", "/orders", {
      token,
      headers: { "Idempotency-Key": key },
      body: { addressId, deliveryMethod: "standard", expectedTotalPaise: preview.body.expectedTotalPaise },
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.order.id).toBe(placed.body.order.id);

    const doubleClick = await api("POST", "/orders", {
      token,
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: { addressId, deliveryMethod: "standard", expectedTotalPaise: preview.body.expectedTotalPaise },
    });
    expect(doubleClick.body.order.id).toBe(placed.body.order.id);
    expect(await prisma.order.count()).toBe(1);
    expect(rp.createRazorpayOrder).toHaveBeenCalledTimes(1);
    expect((await unitStages(variant.id)).filter((s) => s === "reserved")).toHaveLength(1);
  });

  it("two customers racing for the last unit: exactly one order is placed", async () => {
    const { product, variant } = await makeProduct({ units: 1 });
    const buyers = await Promise.all([makeUser("RaceA"), makeUser("RaceB")]);
    const prepared = [];
    for (const b of buyers) {
      await addToCart(b.token, product, variant);
      const addressId = await makeAddress(b.token);
      const preview = await api("POST", "/orders/preview", { token: b.token, body: { addressId, deliveryMethod: "standard" } });
      prepared.push({ ...b, addressId, expected: preview.body.expectedTotalPaise });
    }
    const results = await Promise.all(
      prepared.map((b) =>
        api("POST", "/orders", {
          token: b.token,
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: { addressId: b.addressId, deliveryMethod: "standard", expectedTotalPaise: b.expected },
        })
      )
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe("out_of_stock");
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.orderItem.count()).toBe(1);
    expect(await unitStages(variant.id)).toEqual(["reserved"]);
  });
});

describe("webhooks and payment failures", () => {
  it("duplicate webhooks racing the verify call confirm the order exactly once", async () => {
    const { token } = await makeUser("Dup");
    const { product, variant } = await makeProduct({ units: 1 });
    await addToCart(token, product, variant);
    const { placed } = await checkout(token);
    const orderId = placed.body.order.id;
    const amount = placed.body.payment.amount;
    rp.fetchRazorpayPayment.mockResolvedValue({ id: "pay_dup", order_id: "order_rzp_1", status: "captured", amount, currency: "INR", method: "card" });

    const event = capturedEvent("order_rzp_1", "pay_dup", amount);
    const results = await Promise.all([
      sendWebhook(event, "evt_1"),
      sendWebhook(event, "evt_1"),
      api("POST", "/payments/razorpay/verify", {
        token,
        body: { razorpay_order_id: "order_rzp_1", razorpay_payment_id: "pay_dup", razorpay_signature: checkoutSignature("order_rzp_1", "pay_dup") },
      }),
    ]);
    expect(results.every((r) => r.status === 200)).toBe(true);

    const redelivery = await sendWebhook(event, "evt_1");
    expect(redelivery.body.outcome).toBe("duplicate");

    expect((await eventTypes(orderId)).filter((t) => t === "payment_succeeded")).toHaveLength(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("confirmed");
    expect(await unitStages(variant.id)).toEqual(["sold"]);
    expect(await prisma.stageTransition.count({ where: { toStage: "sold" } })).toBe(1);
    expect(await prisma.order.count()).toBe(1);
  });

  it("rejects webhooks with a bad signature without recording them", async () => {
    const raw = JSON.stringify(capturedEvent("order_x", "pay_x", 100));
    const res = await api("POST", "/webhooks/razorpay", { body: raw, headers: { "x-razorpay-signature": "nope", "x-razorpay-event-id": "evt_bad" } });
    expect(res.status).toBe(400);
    expect(await prisma.webhookEvent.count()).toBe(0);
  });

  it("a failed attempt keeps the order payable and a retry reuses the same Razorpay order", async () => {
    const { token } = await makeUser("Retry");
    const { product, variant } = await makeProduct();
    await addToCart(token, product, variant);
    const { placed } = await checkout(token);
    const orderId = placed.body.order.id;

    const failure = await api("POST", "/payments/razorpay/failure", {
      token,
      body: { orderId, kind: "failed", razorpayPaymentId: "pay_fail", code: "BAD_REQUEST_ERROR", description: "Card declined" },
    });
    expect(failure.body).toMatchObject({ status: "pending_payment", retryable: true });
    // The same failure arriving by webhook isn't recorded twice.
    await sendWebhook({
      event: "payment.failed",
      payload: { payment: { entity: { id: "pay_fail", order_id: "order_rzp_1", amount: 1, currency: "INR", status: "failed", error_description: "Card declined" } } },
    });
    expect((await eventTypes(orderId)).filter((t) => t === "payment_failed")).toHaveLength(1);

    const retry = await api("POST", "/payments/razorpay/order", { token, body: { orderId } });
    expect(retry.status).toBe(200);
    expect(retry.body.razorpayOrderId).toBe("order_rzp_1");
    expect(rp.createRazorpayOrder).toHaveBeenCalledTimes(1);
    expect((await api("GET", `/orders/${orderId}/status`, { token })).body.isPayable).toBe(true);
  });
});

describe("expiry, reconciliation and late payments", () => {
  async function placedAndExpired(label: string) {
    const { user, token } = await makeUser(label);
    const { product, variant } = await makeProduct({ units: 1 });
    await addToCart(token, product, variant);
    const { placed } = await checkout(token);
    const orderId = placed.body.order.id;
    await prisma.order.update({ where: { id: orderId }, data: { paymentExpiresAt: new Date(Date.now() - 1000) } });
    return { user, token, product, variant, orderId, amount: placed.body.payment.amount as number };
  }

  it("expires unpaid orders: stock released, cart kept, order no longer payable", async () => {
    const { token, variant, orderId } = await placedAndExpired("Expire");
    const run = await runReleaseAbandonedReservationsJob();
    expect(run).toMatchObject({ released: 1, confirmed: 0 });

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("cancelled");
    expect(await unitStages(variant.id)).toEqual(["available"]);
    expect((await api("GET", "/cart", { token })).body.items).toHaveLength(1);
    const pay = await api("POST", "/payments/razorpay/order", { token, body: { orderId } });
    expect(pay.status).toBe(410);
    expect(pay.body.error.code).toBe("order_not_payable");
    expect(await eventTypes(orderId)).toContain("order_expired");
  });

  it("reconciles with Razorpay before expiring — a paid order whose webhook was lost is confirmed", async () => {
    const { orderId, variant, amount } = await placedAndExpired("Reconcile");
    rp.fetchRazorpayOrderPayments.mockResolvedValue([{ id: "pay_lost", status: "captured", amount, currency: "INR", method: "card" }]);
    const run = await runReleaseAbandonedReservationsJob();
    expect(run).toMatchObject({ released: 0, confirmed: 1 });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("confirmed");
    expect(await unitStages(variant.id)).toEqual(["sold"]);
  });

  it("late payment after expiry re-reserves the same units when they're still free", async () => {
    const { orderId, variant, amount } = await placedAndExpired("LateOk");
    await runReleaseAbandonedReservationsJob();
    const res = await sendWebhook(capturedEvent("order_rzp_1", "pay_late", amount));
    expect(res.body.outcome).toBe("processed");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("confirmed");
    expect(await unitStages(variant.id)).toEqual(["sold"]);
    expect(rp.createRazorpayRefund).not.toHaveBeenCalled();
  });

  it("late payment after the unit was sold to someone else is refunded, never oversold", async () => {
    const first = await placedAndExpired("LateA");
    await runReleaseAbandonedReservationsJob();

    // Someone else buys the released unit.
    const second = await makeUser("LateB");
    await addToCart(second.token, first.product, first.variant);
    const { placed } = await checkout(second.token);
    expect(placed.status).toBe(201);
    await sendWebhook(capturedEvent(placed.body.payment.razorpayOrderId, "pay_b", placed.body.payment.amount));

    // Then A's payment finally lands.
    await sendWebhook(capturedEvent("order_rzp_1", "pay_a_late", first.amount));
    expect(rp.createRazorpayRefund).toHaveBeenCalledWith("pay_a_late", first.amount, expect.any(Object));
    const orderA = await prisma.order.findUniqueOrThrow({ where: { id: first.orderId }, include: { payments: true, refunds: true } });
    expect(orderA.status).toBe("refunded");
    expect(orderA.payments[0].status).toBe("refunded");
    expect(orderA.refunds[0]).toMatchObject({ status: "processed", amountPaise: first.amount });
    expect(await unitStages(first.variant.id)).toEqual(["sold"]);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: placed.body.order.id } })).status).toBe("confirmed");
  });

  it("cancelling a paid order before dispatch returns stock and refunds in full", async () => {
    const { token } = await makeUser("Cancel");
    const { product, variant } = await makeProduct({ units: 1 });
    await addToCart(token, product, variant);
    const { placed } = await checkout(token);
    await sendWebhook(capturedEvent("order_rzp_1", "pay_c", placed.body.payment.amount));

    const cancelled = await api("POST", `/orders/${placed.body.order.id}/cancel`, { token });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe("refunded");
    expect(rp.createRazorpayRefund).toHaveBeenCalledWith("pay_c", placed.body.payment.amount, expect.any(Object));
    expect(await unitStages(variant.id)).toEqual(["available"]);

    const tooLate = await api("POST", `/orders/${placed.body.order.id}/cancel`, { token });
    expect(tooLate.status).toBe(409);
  });
});
