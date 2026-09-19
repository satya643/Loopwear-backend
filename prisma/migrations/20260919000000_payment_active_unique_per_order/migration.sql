-- Prevents two concurrent checkout/payment-retry requests from both slipping
-- past the app-level "does an active payment already exist for this order"
-- check and creating duplicate pending/paid Payment rows (and duplicate
-- Stripe PaymentIntents) for the same order. Not representable in
-- schema.prisma's DSL (partial/filtered unique indexes aren't supported
-- there), so this exists only as a hand-written migration — application
-- code in modules/payments and modules/checkout is what actually relies on
-- it (catches the resulting unique-violation and returns the winner).
CREATE UNIQUE INDEX "Payment_orderId_active_unique" ON "Payment" ("orderId") WHERE "status" IN ('pending', 'paid');
