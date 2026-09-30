-- Checkout & order flow: address book, coupons, delivery fee / price
-- breakdown on orders, variant + quantity on cart lines, order events
-- timeline, webhook event log. See docs/CHECKOUT_ORDER_FLOW.md.
--
-- Hand-edited from `prisma migrate diff` output to backfill existing rows
-- (CartItem.variantId is NOT NULL) and to add constraints Prisma's schema
-- language can't express (partial unique index, CHECKs). Like the earlier
-- Payment_orderId_active_unique index, these must survive future diffs.

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('percent', 'flat');
CREATE TYPE "OrderEventType" AS ENUM ('order_created', 'payment_initiated', 'payment_failed', 'payment_cancelled', 'payment_succeeded', 'status_changed', 'order_cancelled', 'order_expired', 'refund_initiated', 'refunded', 'note');
CREATE TYPE "OrderActor" AS ENUM ('customer', 'system', 'operator', 'gateway');
CREATE TYPE "WebhookEventStatus" AS ENUM ('received', 'processed', 'ignored', 'failed');

-- AlterEnum (PostgreSQL 12+: allowed in a transaction; values are not used below)
ALTER TYPE "OrderStatus" ADD VALUE 'payment failed';
ALTER TYPE "OrderStatus" ADD VALUE 'refunded';
ALTER TYPE "PaymentMethod" ADD VALUE 'upi';
ALTER TYPE "PaymentMethod" ADD VALUE 'netbanking';
ALTER TYPE "PaymentMethod" ADD VALUE 'other';

-- ---------------------------------------------------------------------------
-- Cart
-- ---------------------------------------------------------------------------
ALTER TABLE "Cart" ADD COLUMN "couponCode" TEXT;

DROP INDEX "CartItem_cartId_productId_mode_key";

ALTER TABLE "CartItem"
  ADD COLUMN "variantId" TEXT,
  ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "unitPricePaiseSnapshot" INTEGER,
  ADD COLUMN "depositPaiseSnapshot" INTEGER,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing lines predate colour selection: attach them to the product's
-- variant that offers the line's size (active first, oldest first).
UPDATE "CartItem" ci
SET "variantId" = (
  SELECT v."id"
  FROM "ProductVariant" v
  WHERE v."productId" = ci."productId"
  ORDER BY
    (EXISTS (SELECT 1 FROM "VariantSize" s WHERE s."variantId" = v."id" AND s."size" = ci."size")) DESC,
    v."isActive" DESC,
    v."createdAt" ASC,
    v."id" ASC
  LIMIT 1
);

-- A product with no variant at all can't be bought — drop such lines.
DELETE FROM "CartItem" WHERE "variantId" IS NULL;

-- Snapshot today's prices so existing lines don't all report "price changed".
UPDATE "CartItem" ci
SET
  "unitPricePaiseSnapshot" = CASE WHEN ci."mode" = 'rent' THEN p."rentPricePaise" ELSE p."buyPricePaise" END,
  "depositPaiseSnapshot"   = CASE WHEN ci."mode" = 'rent' THEN p."depositPaise" ELSE 0 END
FROM "Product" p
WHERE p."id" = ci."productId";

ALTER TABLE "CartItem" ALTER COLUMN "variantId" SET NOT NULL;
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_quantity_positive" CHECK ("quantity" > 0);

CREATE UNIQUE INDEX "CartItem_cartId_variantId_size_mode_key" ON "CartItem"("cartId", "variantId", "size", "mode");
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Address book
-- ---------------------------------------------------------------------------
CREATE TABLE "Address" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'Home',
    "fullName" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "landmark" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'IN',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Address_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Address_userId_idx" ON "Address"("userId");
-- At most one default address per user (not expressible in schema.prisma).
CREATE UNIQUE INDEX "Address_userId_default_unique" ON "Address"("userId") WHERE "isDefault";
ALTER TABLE "Address" ADD CONSTRAINT "Address_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Coupons
-- ---------------------------------------------------------------------------
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "type" "DiscountType" NOT NULL,
    "value" INTEGER NOT NULL,
    "maxDiscountPaise" INTEGER,
    "minSubtotalPaise" INTEGER NOT NULL DEFAULT 0,
    "appliesTo" "CartMode",
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "usageLimit" INTEGER,
    "perUserLimit" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Coupon_value_valid" CHECK ("value" > 0 AND ("type" <> 'percent' OR "value" <= 100))
);
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "discountPaise" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CouponRedemption_orderId_key" ON "CouponRedemption"("orderId");
CREATE INDEX "CouponRedemption_couponId_idx" ON "CouponRedemption"("couponId");
CREATE INDEX "CouponRedemption_userId_couponId_idx" ON "CouponRedemption"("userId", "couponId");
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
ALTER TABLE "Order"
  ADD COLUMN "subtotalPaise" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "discountPaise" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryFeePaise" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "couponId" TEXT,
  ADD COLUMN "couponCode" TEXT,
  ADD COLUMN "addressId" TEXT,
  ADD COLUMN "deliveryMethod" TEXT,
  ADD COLUMN "deliveryMethodLabel" TEXT,
  ADD COLUMN "deliveryEtaMinDays" INTEGER,
  ADD COLUMN "deliveryEtaMaxDays" INTEGER,
  ADD COLUMN "paymentExpiresAt" TIMESTAMP(3),
  ADD COLUMN "checkoutFingerprint" TEXT,
  ADD COLUMN "sourceCartItemIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "confirmedAt" TIMESTAMP(3),
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Before this migration totalPaise was the item subtotal (no fees/discounts).
UPDATE "Order" SET "subtotalPaise" = "totalPaise";

CREATE INDEX "Order_customerId_status_idx" ON "Order"("customerId", "status");
CREATE INDEX "Order_status_paymentExpiresAt_idx" ON "Order"("status", "paymentExpiresAt");
ALTER TABLE "Order" ADD CONSTRAINT "Order_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_addressId_fkey" FOREIGN KEY ("addressId") REFERENCES "Address"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrderItem"
  ADD COLUMN "variantId" TEXT,
  ADD COLUMN "productName" TEXT,
  ADD COLUMN "color" TEXT,
  ADD COLUMN "imageUrl" TEXT;

-- Best-effort snapshots for historical items: the unit's own variant when
-- one was allocated, otherwise the product's first variant.
UPDATE "OrderItem" oi
SET
  "productName" = p."name",
  "variantId" = COALESCE(
    (SELECT gu."variantId" FROM "GarmentUnit" gu WHERE gu."id" = oi."garmentUnitId"),
    (SELECT v."id" FROM "ProductVariant" v WHERE v."productId" = oi."productId" ORDER BY v."createdAt" ASC, v."id" ASC LIMIT 1)
  )
FROM "Product" p
WHERE p."id" = oi."productId";

UPDATE "OrderItem" oi
SET "color" = v."color"
FROM "ProductVariant" v
WHERE v."id" = oi."variantId";

ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "OrderEvent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" "OrderEventType" NOT NULL,
    "status" "OrderStatus",
    "message" TEXT NOT NULL,
    "actor" "OrderActor" NOT NULL,
    "actorUserId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OrderEvent_orderId_createdAt_idx" ON "OrderEvent"("orderId", "createdAt");
ALTER TABLE "OrderEvent" ADD CONSTRAINT "OrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Payments / refunds / webhooks
-- ---------------------------------------------------------------------------
ALTER TABLE "Payment"
  ADD COLUMN "failureCode" TEXT,
  ADD COLUMN "failureReason" TEXT,
  ADD COLUMN "paidAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Payment" SET "paidAt" = "createdAt" WHERE "status" IN ('paid', 'partially_refunded', 'refunded');

ALTER TABLE "Refund"
  ADD COLUMN "orderId" TEXT,
  ALTER COLUMN "orderItemId" DROP NOT NULL;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_target_present" CHECK ("orderItemId" IS NOT NULL OR "orderId" IS NOT NULL);

CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'received',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "WebhookEvent_provider_eventId_key" ON "WebhookEvent"("provider", "eventId");
