# Guest → Purchase: Checkout & Order Flow

Design for the end-to-end purchase flow across the customer shop
(`Rent-wear-Frontend`), the admin console (`admin-frontend`) and this backend.
The reference diagram was used for **business logic only**; UI is our own.

> Ground rules this design enforces everywhere:
> 1. The backend is the only source of truth for price, stock, discount,
>    delivery fee and the final amount. The frontend only *displays* and
>    *echoes back* what the backend quoted.
> 2. An order is only **confirmed** after the backend has verified the payment
>    with the gateway. Nothing the browser says marks an order paid.
> 3. Every state change that money depends on is idempotent and safe to
>    replay (client retries, double clicks, duplicate webhooks).

---

## 0. What already existed vs. what was missing

Inspected: all three repos, `prisma/schema.prisma` + 9 migrations, auth, cart,
checkout, payments, orders, console orders, jobs, and the shop's
cart-context / checkout / payment components.

### Already in place (reused)

| Area | What exists |
|---|---|
| Catalog | `GET /products` (search, category, occasion, style, size, colour, price filters, pagination), `GET /products/:id` with per-size availability. Admin writes the same tables via `/console/products` — **one product source**. |
| Stock model | `GarmentUnit` = one physical item per (variant, size). Stock is *derived* (count of units), never a counter. Rentals are date-window aware. |
| Auth | Email+password (bcrypt), phone OTP (hashed, TTL, attempt cap, resend cooldown, daily cap), Google ID-token sign-in, JWT + server-side `Session` table (revocable), password reset. Shop holds the JWT in an **httpOnly, SameSite=Lax, Secure-in-prod** cookie (BFF pattern — the browser never sees the token). |
| Checkout | Idempotency-Key on checkout, `SELECT … FOR UPDATE SKIP LOCKED` unit allocation, partial unique index "one active payment per order". |
| Payments | Razorpay order creation, checkout-signature verification (HMAC, timing-safe), webhook signature verification; Stripe for non-INR. |
| Ops | Console order state machine, garment lifecycle state machine, deposit refunds. |

### Gaps and defects found (fixed by this work)

| # | Problem | Impact |
|---|---|---|
| 1 | Checkout **cleared the cart and created the order before payment**. | A failed/abandoned payment lost the customer's bag. |
| 2 | Delivery address was **optional** at checkout; no address book (localStorage only). | Orders could be placed with nowhere to ship. |
| 3 | No delivery methods, delivery fee, coupons, or order price breakdown. | Totals were only item prices + deposit. |
| 4 | Cart had **no variant (colour) and no quantity**; stock was checked per product across all colours. | "White M" could be fulfilled by a black unit. |
| 5 | No stock check when adding to cart; no revalidation before checkout. | Out-of-stock items only failed at payment time. |
| 6 | Buy-mode allocation re-locked a unit without re-checking `stage='available'`; rent allocation didn't re-check overlap after locking. | Two concurrent checkouts could win the same unit. |
| 7 | Rent allocation for a *future* window overwrote the stage/`currentOrderId` of a unit currently rented to someone else. | Corrupted the live rental's lifecycle state. |
| 8 | Payment finalisation read-then-wrote without a guard. | Concurrent verify + webhook double-ran side effects. |
| 9 | Retry after closing the Razorpay popup was broken (backend returned the pending payment without a Razorpay order id; UI showed "payment already in progress"). | No way to retry payment. |
| 10 | Late payment (arrives after the hold was released) re-confirmed an order whose units may already belong to someone else. | Overselling. |
| 11 | No `payment.failed` handling, no webhook event-id idempotency, verify endpoint didn't check ownership or amount. | |
| 12 | No order timeline/events; shop timeline compared API codes (`with_customer`) against labels (`with customer`) so later steps never lit up. | |
| 13 | Operators could move `pending_payment → confirmed` manually. | An unpaid order became "confirmed" and buy units never moved to `sold`. |
| 14 | Two duplicate release jobs (acknowledged in `config/business.ts`), and nothing scheduled them. | Abandoned reservations were never released in practice. |
| 15 | Rate limiters keyed only on IP, but every shop request reaches the API from the Next.js server's IP. | 20 sign-in attempts site-wide per 15 min would lock out **everyone**. |
| 16 | OTP codes from `Math.random`; OTP attempt counter racy; sign-up with a phone held by another unverified account → 500. | |
| 17 | `.env.example` committed with unresolved merge-conflict markers. | |

Known risk, **not** changed here (needs a product decision): email addresses
are never verified, so an attacker can register a victim's email (verifying
with their own phone); if the victim later uses Google sign-in, Google gets
linked to that account (account pre-hijacking). Recommended fix: email
verification, or refuse to auto-link Google to a password account whose email
was never verified.

---

## A. End-to-end request / data flow

Format per step: **Frontend action → API → validation → business logic → DB → external → response → next step.**

1. **Discover** — Shop loads `/discover` → `GET /api/products?q&category&…` + `GET /api/categories` → zod-validated query → only `isActive` products, filters in SQL → `Product`, `ProductVariant`, `Category` reads → paginated list with display-currency pricing → render grid.
2. **Product detail** — `/product/:id` → `GET /api/products/:id` → product must exist and be active (404 otherwise) → per-variant, per-size stock computed from `GarmentUnit` (buy: units `available` with no future rental booking; rent: units free for the default window) → variants with sizes + stock → customer picks colour, size, quantity.
3. **Add to cart** — `POST /api/cart/items {productId, variantId, size, mode, quantity, startDate?}` → auth (guests keep a local cart, see §E) → product active, variant active & belongs to product, size offered by variant, quantity 1–5, rental date not in the past → stock ≥ quantity for that variant/size (and rental window) → **price read from DB** and stored as a *snapshot* on the line → upsert `CartItem` on `(cart, variant, size, mode)` → full validated cart → drawer opens / error banner. Errors: `product_unavailable` 404, `variant_unavailable` 409, `out_of_stock` 409 (with `available`).
4. **Cart** — `GET /api/cart` → every line re-validated (exists / active / stock / price vs snapshot) → subtotal, coupon discount, deposit computed server-side → lines flagged `ok | warning | blocked` with issue codes → UI shows fixes (remove, reduce quantity, "price changed from X to Y").
5. **Checkout gate** — "Checkout" → `/checkout` (Next middleware: no session cookie → `/sign-in?redirectTo=/checkout`) → after login the guest cart is merged (`POST /api/cart/merge`) → `POST /api/cart/revalidate` (refreshes price snapshots, reports changes) → `GET /api/checkout` → 401 for guests; otherwise returns validated cart, saved addresses, default address, delivery methods, blockers.
6. **Auth** — see §E.
7. **Address** — `GET/POST/PATCH/DELETE /api/addresses` → zod: name, E.164 phone, line1, city, Indian state (from list), 6-digit PIN, country `IN`; sanitised (trim, control chars stripped) → `Address` rows owned by the user; one default enforced by a partial unique index → selected address id kept in UI state.
8. **Delivery method** — `GET /api/shipping/methods?addressId=` → address owned & serviceable → methods from `BUSINESS_RULES.delivery` with fee, ETA dates, availability per PIN → UI radio list.
9. **Review** — `POST /api/orders/preview {addressId, deliveryMethod}` → full server-side validation (cart, products, variants, stock, prices, coupon, address, method) → recomputed `subtotal − discount + delivery = total`, `+ deposit = grand total` → quote + issues + `canPlaceOrder`.
10. **Place order & pay** — `POST /api/orders {addressId, deliveryMethod, expectedTotalPaise}` + `Idempotency-Key` → **final validation** (same as preview) → recomputed grand total must equal `expectedTotalPaise` else `409 price_changed` with a fresh preview → *transaction*: supersede the user's other unpaid orders, lock & reserve units, create `Order(pending_payment)` + `OrderItem` snapshots + `OrderEvent(order_created)`, hold expires in 30 min; **cart is not touched** → Razorpay order created (external) → `201 {order, payment session}` → Razorpay Checkout opens.
11. **Payment callback** — widget success → `POST /api/payments/razorpay/verify` → payment belongs to caller → HMAC signature check → **fetch payment from Razorpay** (status, amount, currency, order id; capture if only authorised) → `finalizeOrderPayment` (idempotent) → order `confirmed`, buy units `sold`, coupon redemption, purchased cart lines removed, events → confirmation email/SMS (best-effort) → `/orders/:id?placed=1`.
    Widget failure/dismiss → `POST /api/payments/razorpay/failure` → event recorded, order stays payable until the hold expires → "Retry payment" re-opens the **same** Razorpay order.
12. **Webhook** — Razorpay → `POST /api/webhooks/razorpay` → HMAC over raw body with the webhook secret → dedupe on `x-razorpay-event-id` (`WebhookEvent`) → `payment.captured`/`order.paid` → same `finalizeOrderPayment`; `payment.failed` → failure event; `refund.processed/failed` → refund row. Never creates orders.
13. **Confirmation** — `GET /api/orders/:id` → owner only → breakdown, address snapshot, items, payment, timeline.
14. **Track** — `GET /api/orders/:id/status` (lightweight, pollable) → status, steps, timeline from `OrderEvent`.

## B. Frontend pages / components (customer shop)

| Route / component | Role |
|---|---|
| `/discover`, `components/shop/DiscoverFeed`, `FilterBar`, `ProductTicket` | Listing, search, filters (backend data). Quick add uses the product's default colour. |
| `/product/[id]`, `ProductDetail`, `VariantPicker`, `QuantityStepper` | Colour → size → quantity, live stock per variant, server errors shown inline. |
| `CartDrawer` | Server-validated lines, quantity steppers, per-line issues, server totals, checkout gate. |
| `lib/shop/cart-context.tsx` | Cart state keyed by cart-item id; guest cart in localStorage; one-shot merge on sign-in; `cartSynced` flag so checkout never reads a half-merged cart. |
| `/checkout` → `components/shop/checkout/CheckoutFlow` | Stepper: **Address → Delivery → Review & pay**. Persistent `OrderSummary` (server preview), `CouponField`, `IssueList`. |
| `checkout/AddressStep`, `AddressFormDialog` | Pick / add / edit saved addresses. |
| `checkout/DeliveryStep` | Delivery methods with fees and ETA. |
| `checkout/ReviewStep` + `payment/RazorpayCheckout` | Final preview, place order, Razorpay widget, failure + retry. |
| `/orders/[id]` | Confirmation (`?placed=1`), price breakdown, address, timeline; polls while payment is processing. |
| `/account/orders`, `/account/address` | Order history; address book backed by `/api/addresses`. |
| `/sign-in`, `/sign-up`, `/verify-otp` | Unchanged UI; every form carries `redirectTo`. |

Server Actions (`lib/shop/*-actions.ts`) are the only callers of authenticated endpoints; they read the httpOnly cookie and attach the bearer token.

## C. Backend routes / services

| Module | Routes | Service responsibilities |
|---|---|---|
| `catalog` | `GET /api/categories`, `GET /api/products`, `GET /api/products/:id`, `GET /api/products/:id/availability` | Listing, detail with per-variant stock. |
| `availability` | — | `findFreeRentalUnitIds`, `findBuyableUnitIds`, per-variant stock. |
| `cart` | `GET /api/cart`, `POST /api/cart/items`, `PATCH/DELETE /api/cart/items/:itemId`, `POST/DELETE /api/cart/coupon`, `POST /api/cart/revalidate`, `POST /api/cart/merge` | `validation.ts` (line issues), `service.ts`. |
| `checkout` | `GET /api/checkout` (+ legacy `POST /api/checkout` shim) | Checkout bootstrap. |
| `addresses` | `GET/POST /api/addresses`, `PATCH/DELETE /api/addresses/:id`, `POST /api/addresses/:id/default`, `GET /api/addresses/regions` | Ownership, validation, default handling. |
| `shipping` | `GET /api/shipping/methods` | Methods, fee, ETA, serviceability. |
| `coupons` | `/api/console/coupons` (admin) | `evaluateCoupon` (pure). |
| `pricing` | — | `computeQuote` (pure). |
| `orders` | `POST /api/orders/preview`, `POST /api/orders`, `GET /api/orders`, `GET /api/orders/:id`, `GET /api/orders/:id/status`, `POST /api/orders/:id/cancel` | `placement.ts` (final validation + transaction), `inventory.ts` (allocate/reserve/release), `events.ts`, `timeline.ts`. |
| `payments` | `POST /api/payments/razorpay/order`, `POST /api/payments/razorpay/verify`, `POST /api/payments/razorpay/failure` (+ existing Stripe routes) | `session.ts`, `finalize.ts`, `refunds.ts`. |
| `webhooks` | `POST /api/webhooks/razorpay` (legacy `/api/payments/razorpay-webhook` kept) | Signature, event dedupe, dispatch. |
| `notifications` | — | Order confirmation email/SMS, ops notifications. |
| `jobs` | `releaseAbandonedReservations` (+ in-process scheduler) | Reconcile with Razorpay, then expire unpaid orders. |

### Response conventions

* Success: the resource itself (`200`/`201`), lists as `{ items, page, pageSize, total, totalPages }`, `204` for empty.
* Error: `{ "error": { "code": "out_of_stock", "message": "human readable", "details": {…} } }`.

| Status | Codes |
|---|---|
| 400 | `bad_request`, `validation_error`, `cart_empty` |
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `not_found`, `product_unavailable` |
| 409 | `conflict`, `out_of_stock`, `variant_unavailable`, `cart_invalid`, `price_changed`, `coupon_invalid`, `order_not_payable`, `idempotency_conflict` |
| 410 | `order_expired` |
| 422 | `address_invalid`, `delivery_unavailable` |
| 429 | `rate_limited` |
| 502 | `bad_gateway`, `payment_verification_failed` |

## D. Database tables / relations

Existing tables are extended, not rewritten. New: `Address`, `Coupon`,
`CouponRedemption`, `OrderEvent`, `WebhookEvent`.

```
User 1─* Address            User 1─1 Cart 1─* CartItem *─1 ProductVariant *─1 Product *─1 Category
User 1─* Order 1─* OrderItem *─1 ProductVariant (nullable, snapshot kept)
                  OrderItem *─1 GarmentUnit (one row per physical unit)
Order *─1 Address (SetNull — the order keeps its own address snapshot)
Order *─1 Coupon (SetNull)   Coupon 1─* CouponRedemption *─1 Order (unique)
Order 1─* Payment 1─* Refund (Refund.orderItemId OR Refund.orderId)
Order 1─* OrderEvent        WebhookEvent (provider, eventId) unique
```

| Table | Change |
|---|---|
| `CartItem` | `+variantId` (backfilled to the product's first variant), `+quantity`, `+unitPricePaiseSnapshot`, `+depositPaiseSnapshot`, `+updatedAt`; unique `(cartId, variantId, size, mode)` replaces `(cartId, productId, mode)`. |
| `Cart` | `+couponCode`. |
| `Order` | `+subtotalPaise` (backfilled from `totalPaise`), `+discountPaise`, `+deliveryFeePaise`, `+couponId/couponCode`, `+addressId`, `+deliveryMethod/Label/EtaMinDays/EtaMaxDays`, `+paymentExpiresAt`, `+checkoutFingerprint`, `+sourceCartItemIds`, `+confirmedAt/cancelledAt/cancelReason`, `+updatedAt`. `totalPaise` = subtotal − discount + delivery; charged = `totalPaise + depositTotalPaise`. |
| `OrderStatus` | `+payment_failed`, `+refunded`. |
| `OrderItem` | `+variantId`, `+productName`, `+color`, `+imageUrl` (snapshots). One row per unit; the API groups rows into lines with `quantity`. |
| `Payment` | `+failureCode`, `+failureReason`, `+paidAt`, `+updatedAt`; `PaymentMethod += upi, netbanking, other`. |
| `Refund` | `orderItemId` nullable, `+orderId` (whole-order refunds). |

## E. Authentication flow

* **Session**: backend issues a JWT (`sub`, `sessionId`, `role`, 7-day expiry) and a `Session` row; every request checks the row is not revoked/expired. The Next.js server stores the JWT in `loopwear_token` (httpOnly, SameSite=Lax, Secure in production, 7 days) and forwards it as `Authorization: Bearer` from Server Actions.
* **Email + password**: sign-up validates name, email, E.164 phone, password (≥ 8, letter + digit on the client, 8–128 on the server), confirm-password; duplicate *verified* email/phone → 409; bcrypt hash; OTP sent to the phone; `POST /verify-otp` completes sign-up and returns a session. Sign-in checks the password **before** the verified flag (no enumeration).
* **Phone OTP**: 6 digits from `crypto.randomInt`, bcrypt-hashed, 10-min TTL, 5 attempts per code (claimed atomically), 45 s resend cooldown, 5 sends/day/phone.
* **Google**: Google Identity Services returns an ID token → `POST /auth/google` verifies signature + audience + `email_verified` with `google-auth-library` → find by `googleId`, else link by email, else create → session.
* **Rate limiting**: credential endpoints keyed by IP **+ identifier** (email/phone); general limiter keyed by user id when signed in. The shop forwards the end-user IP in `X-Forwarded-For`; `TRUST_PROXY` tells Express how many hops to trust.
* **Checkout gate & return**: middleware sends guests to `/sign-in?redirectTo=/checkout`; every auth action redirects to a validated same-origin `redirectTo`; on arrival the guest cart (localStorage) is merged into the account cart *before* checkout loads.

## F. Cart / checkout flow

```
Guest adds items ──► localStorage cart (variant, size, mode, qty, date)
      │ Checkout
      ▼
/sign-in?redirectTo=/checkout ──► session cookie ──► /checkout
      │
      ├─ POST /cart/merge  (max(existing, incoming) qty, capped by stock; report dropped lines)
      ├─ POST /cart/revalidate  (refresh price snapshots, report price changes)
      ├─ GET  /checkout  (cart + addresses + methods + blockers)
      ├─ Address step  ──► /addresses (select / create / edit)
      ├─ Delivery step ──► /shipping/methods?addressId
      ├─ Review        ──► POST /orders/preview  (authoritative quote)
      └─ Place order   ──► POST /orders {expectedTotalPaise}  (+ Idempotency-Key)
```

Line issue codes: `product_unavailable`, `variant_unavailable`, `out_of_stock`,
`insufficient_stock`, `price_changed`, `rental_date_invalid`. Blocked lines
(first four) must be removed / reduced before checkout; `price_changed` is a
warning, and the final guard is `expectedTotalPaise`.

Coupons: `POST /api/cart/coupon {code}` validates (active, date window,
minimum subtotal, global and per-user usage, rent/buy scope) and stores the
code on the cart; the discount is recomputed on every read and silently
dropped (with a `coupon.status = "invalid"` message) if it stops applying.
Redemptions are written only when payment is confirmed.

Duplicate order protection: `Idempotency-Key` (same key → same order), plus a
checkout fingerprint (items + address + method + coupon + total): an unpaid,
unexpired order with the same fingerprint is returned instead of creating a
second one. A new, different order supersedes (releases) the user's older
unpaid orders so abandoned attempts don't hold stock.

## G. Razorpay payment + webhook flow

```
POST /orders ──► Order(pending_payment, hold 30 min) ──► Razorpay orders.create(amount = grand total)
                                                         └► Payment(pending, gatewayRef = rzp order id)
Browser: Razorpay Checkout(order_id)
  ├─ success ─► POST /payments/razorpay/verify
  │              1 payment exists & belongs to caller
  │              2 HMAC(order_id|payment_id, key_secret) == signature
  │              3 payments.fetch → status captured|authorized, amount & currency match, order_id matches
  │                (authorized → capture)   fetch failure → 202 "processing", webhook/job completes it
  │              4 finalizeOrderPayment()
  ├─ payment.failed ─► POST /payments/razorpay/failure → event; retry re-opens the same rzp order
  └─ dismissed      ─► POST /payments/razorpay/failure {kind: dismissed} → event; order stays payable

Razorpay ─► POST /webhooks/razorpay
              HMAC(raw body, webhook_secret) ─► WebhookEvent insert (provider,eventId unique)
              duplicate & processed → 200 no-op
              payment.captured | order.paid → finalizeOrderPayment()
              payment.failed → failure event
              refund.processed | refund.failed → Refund status
```

`finalizeOrderPayment` (single implementation for verify, webhook, reconcile job):

1. In a transaction, **claim** the payment: `UPDATE Payment SET status='paid' WHERE id=? AND status IN ('pending','failed')`. Zero rows → someone else already finalised → return current state (no side effects).
2. Lock the order row (`FOR UPDATE`).
3. `pending_payment` → `confirmed`: buy units `reserved → sold`, coupon redemption, delete the order's source cart lines, `OrderEvent(payment_succeeded)`.
4. Order already expired (`payment_failed`/`cancelled`, stock released) → try to re-reserve the same units; if all are still free, confirm as above; otherwise mark for refund.
5. After commit: full refund (if step 4 failed) and confirmation email/SMS — best-effort, never rolls back the payment.

## H. Order lifecycle

```
                 ┌──────── payment verified ───────┐
pending_payment ─┤                                 ▼
  │   │          │                             confirmed ──► packed ──► shipped ──► with_customer ──► return_in_transit ──► closed
  │   │          │                                 │                     (out for      (delivered) │     (rentals)            ▲
  │   │          │                                 │                      delivery)                 └───── buy-only ─────────┘
  │   │          │                    customer/operator cancel ─► cancelled ─► refunded (full refund issued)
  │   └ hold expired after failed attempt ─► payment_failed
  └ customer cancel / superseded / hold expired ─► cancelled
late payment on expired order ─► confirmed (units re-reserved) or refunded
```

* Only payment verification moves `pending_payment → confirmed` (the manual console transition is removed).
* Every transition writes an `OrderEvent {type, status, message, actor}`; the shop timeline is built from these with real timestamps.
* Customer-facing labels: pending_payment "Awaiting payment", confirmed "Order placed", packed "Packed", shipped "Out for delivery", with_customer "Delivered", return_in_transit "Return in transit", closed "Completed", cancelled "Cancelled", payment_failed "Payment failed", refunded "Refunded".
* Inventory: buy units `available → reserved → sold`; rent units `available → reserved → rented → …` (units booked for a future window while busy are left in their current stage — the booking lives on `OrderItem` dates). Release only touches units whose `currentOrderId` is this order.

## I. Error / edge-case flow

| Case | Detection | Response | Frontend |
|---|---|---|---|
| Product deleted / unpublished | Cart read, add, preview, place | line `product_unavailable`; add → 404 | Line greyed, "Remove" CTA; checkout blocked |
| Out of stock / insufficient | Stock count per variant/size (+ window) | `out_of_stock` 409 `{available}` / line issue | "Only N left" + reduce/remove |
| Variant unavailable | Variant inactive or size dropped | `variant_unavailable` | Pick another colour/size |
| Cart item changed | Revalidate on checkout entry | Issues list | Banner listing changes |
| Price changed during checkout | `expectedTotalPaise` mismatch | 409 `price_changed` + fresh preview | "Prices updated" dialog, confirm new total |
| Invalid / expired coupon | `evaluateCoupon` | 409 `coupon_invalid` (apply) / `coupon.status=invalid` (read) | Inline message, total without discount |
| Auth failure | 401 from any authed route | `unauthorized` | Redirect to sign-in with `redirectTo` |
| Invalid / expired OTP | `consumeOtp` | 400 with attempts left / expired | Inline error, resend |
| OTP resend limit | cooldown / daily cap | 429 `rate_limited` | Countdown |
| Invalid address | schema + serviceability | 422 `address_invalid` `{fieldErrors}` | Field errors |
| Delivery unavailable | method inactive / PIN not serviceable | 422 `delivery_unavailable` | Choose another method / address |
| Payment failure | widget `payment.failed`, webhook | Order stays payable until hold expires | "Payment failed — retry" |
| Payment cancellation | widget dismissed | Event only | "Payment not completed — retry / cancel order" |
| Duplicate webhook | `WebhookEvent` unique + conditional claim | 200 no-op | — |
| Duplicate order request | Idempotency-Key + fingerprint | Same order returned | — |
| Order creation failure | Transaction rollback | Nothing persisted; 409/5xx | Error, cart intact |
| Payment gateway down at order time | Razorpay create fails after commit | 502 `{orderId}` | "Retry payment" (same order) |
| Verify can't reach Razorpay | fetch throws | 202 `payment_processing` | Poll `/orders/:id/status` |
| Late payment after hold | finalize step 4 | Re-reserve or auto-refund | Order page shows outcome |
| Network / API failure | `apiFetch` status 0 | — | Retry button, nothing lost (server state is idempotent) |

## J. Implementation phases (status)

| Phase | Scope | Status / verification |
|---|---|---|
| **1. Schema** | Migration `20260930000000_checkout_order_flow` with backfills (cart line → variant + price snapshot, order subtotal, order-item snapshots), new tables, enum values, partial unique index (one default address), CHECK constraints. | Done. Applied to a fresh DB and to dev (existing cart lines backfilled); `prisma migrate diff` shows no drift. |
| **2. Domain services** | `pricing/quote`, `coupons/evaluate`, `shipping/methods`, `addresses/schemas` (pure, unit-tested); variant-aware availability; race-safe allocation (`orders/inventory`). | Done. 37 new unit tests. |
| **3. Cart, addresses, shipping, checkout gate** | Cart rewrite, merge, revalidate, coupons; address book; delivery options; `GET /checkout`; `GET /categories`; per-variant stock on product detail. | Done. |
| **4. Orders & payments** | Preview, placement, payment session (retry reuses the Razorpay order), verify (fetch/capture/amount), failure reporting, `finalizeOrderPayment`, webhooks + `WebhookEvent`, cancel/refund, events & timeline, notifications, consolidated reconcile/release job + in-process scheduler, console transitions, admin coupon endpoints. | Done. 16 integration tests (`npm run test:integration`) incl. two customers racing for the last unit, duplicate webhooks racing verify, late payment re-reserve vs. refund, expiry + reconcile. Live smoke test against the Razorpay sandbox. |
| **5. Security hardening** | `crypto.randomInt` OTPs, atomic OTP attempts, sign-up phone conflict, identity-keyed rate limits + `TRUST_PROXY`, CORS allow-list, `.env.example` conflict markers resolved. | Done. |
| **6. Customer frontend** | Cart context (server-truth bag, guest merge, `cartSynced`), PDP colour/size/qty, cart drawer, checkout stepper, Razorpay failure/retry, confirmation + tracking, address book, orders list status fixes. | Done. `tsc`, lint and `next build` clean; SSR smoke-tested. |
| **7. Admin frontend** | New statuses/methods in types & meta, backend-driven transitions, order price breakdown + timeline. | Done. `tsc` and `next build` clean. |

## K. Deploying

1. **Backend first.** Run `npx prisma migrate deploy`. The old shop's `POST /checkout` keeps working through a compatibility shim (it now goes through the same safe order path), so the shop can deploy afterwards. Remove the shim once every shop build uses `POST /orders`.
2. **Razorpay webhook** — set `RAZORPAY_WEBHOOK_SECRET` and point the dashboard at `https://<api>/api/webhooks/razorpay` (events: `payment.captured`, `payment.authorized`, `payment.failed`, `order.paid`, `refund.processed`, `refund.failed`). Without it, confirmation still happens via the checkout verify call and the reconcile job, but a customer who closes the tab right after paying waits for the next job run (≤ 5 min after the hold).
3. **`TRUST_PROXY=1`** when only the shop's Next.js server calls the API (so per-shopper rate limits use the forwarded IP); **`CORS_ORIGINS`** to the shop and admin origins.
4. **Jobs** — the release/reconcile job runs in-process every 5 minutes (`RUN_JOBS_IN_PROCESS=true`). It is idempotent, so multiple instances are fine.

## L. Known gaps / follow-ups

* **Admin UI for coupons** — the API exists (`/api/console/coupons`); the admin screen doesn't yet.
* **Email provider** — `sendEmail` logs to the console until a provider is wired in `modules/auth/email.ts`.
* **Google OAuth redirect UX** — sign-in uses Google Identity Services ID tokens (verified server-side); a full-page redirect variant isn't implemented.
* **Account pre-hijacking via unverified email** (see §0).
* **Rental start date vs. delivery ETA** — a rental can start before the chosen delivery method could arrive; not validated yet (needs a business rule).
* **Two lines competing for the same units** (e.g. rent *and* buy of the same colour/size) are validated separately in the cart; placement allocates them together and reports `out_of_stock` if they can't both be met.
* Under exact concurrency, `SKIP LOCKED` can report a rental unit as unavailable to one of two shoppers booking *non-overlapping* dates; the shopper retries. It can never double-book.
