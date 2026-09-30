# LoopWear Backend

Node.js + TypeScript + Express + PostgreSQL (Prisma) API for the LoopWear
Shop, Concourse (operator console) and Auth surfaces.

## Stack

- **Runtime**: Node 20, TypeScript, Express
- **DB**: PostgreSQL via Prisma ORM
- **Auth**: JWT (7-day TTL) + server-side session revocation table, email/password + phone OTP
- **Payments**: Razorpay for INR (orders, checkout signature, webhooks); Stripe (PaymentIntents) for other currencies
- **Checkout & orders**: see **[docs/CHECKOUT_ORDER_FLOW.md](./docs/CHECKOUT_ORDER_FLOW.md)** for the full guest → purchase flow, order lifecycle and edge cases
- **Currency**: base currency is INR (paise); display currency resolved per-request via IP geolocation (`geoip-lite`) with explicit override, converted using a cached FX rate table

## Setup

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL, JWT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
npx prisma migrate dev      # creates the schema against your Postgres instance
npm run seed                # demo users/products/units
npm run dev                 # http://localhost:4000
```

`npm run dev` always applies any pending migrations first (via a `predev`
hook running `prisma migrate deploy`) — so after pulling new commits, just
re-run `npm run dev` rather than manually tracking whether new migrations
landed. If you see a Prisma error like `column ... does not exist` or
`table ... does not exist`, it means you ran the server some other way
(e.g. `tsx src/server.ts` directly) that skipped this hook; run
`npx prisma migrate deploy` yourself in that case.

Demo accounts from the seed script (password `Password123!`):
- `admin@loopwear.dev` — role `admin` (Concourse access)
- `customer@loopwear.dev` — role `customer`

Scheduled jobs (run via your own scheduler — no scheduler infra is assumed here):
```bash
npm run jobs:daily-metrics       # nightly analytics aggregation
npm run jobs:fx-rates            # refresh currency conversion rates
npm run jobs:delayed-deliveries  # persist delayed-status flips (also computed live)
npm run jobs:release-reservations # reconcile + release unpaid orders (also runs in-process every 5 min)
```

Tests:
```bash
npm test                          # unit tests, no database
# integration tests hit a real, DISPOSABLE Postgres (they truncate every table):
DATABASE_URL=$TEST_DATABASE_URL npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://…/loopwear_test npm run test:integration
```

## Architecture notes (mapped to the build spec)

- **`products` vs `garment_units`** (§2): kept as two separate tables — a
  `Product` is a design, a `GarmentUnit` is one physical, sku-tracked item
  with its own lifecycle stage. The Shop's per-size availability is a
  *derived* view (`modules/availability/service.ts`), computed from real
  units + their order history for a given date range — not a static flag.
- **Lifecycle state machine** (`modules/console/lifecycle/stateMachine.ts`):
  the frontend's 8 stages plus two terminal states the original enum had no
  exit for — `retired` (failed inspection permanently) and `sold` (a "buy"
  order takes a unit out of rental circulation for good; not in the original
  spec but required for correctness). Transitions are validated server-side
  against a strict table, not free text.
- **Money**: every price is an integer in the base currency's minor unit
  (paise). Display conversion happens at the API boundary
  (`lib/pricing.ts` + `lib/fx.ts`) — accounting always stays in base currency.
- **Concurrency**: checkout allocates a specific `GarmentUnit` row with
  `SELECT ... FOR UPDATE SKIP LOCKED` inside a transaction
  (`modules/checkout/service.ts`), so two simultaneous checkouts for the
  last unit of a size can't both succeed.
- **Idempotency**: `/api/checkout` requires an `Idempotency-Key` header;
  `/api/payments/confirm` and the Stripe webhook are idempotent by
  `gatewayRef` (the PaymentIntent id) — safe to retry or double-deliver.
- **RBAC**: every `/api/console/*` route requires `role IN (operator, admin)`,
  enforced server-side in `middleware/rbac.ts` — closing the original
  frontend's complete lack of an auth gate on the Concourse.
- **Session revocation**: JWTs carry a `sessionId`; every authenticated
  request does one indexed lookup against the `sessions` table to check
  `revokedAt`/`expiresAt`, so logout and logout-everywhere actually work
  (a pure stateless JWT can't support that).

## Business rules that were left undefined by the spec (§8)

Defaults are centralized in `src/config/business.ts` — confirm these with
stakeholders before relying on them in production:

| Rule | Default | 
|---|---|
| Deposit refund by return condition | excellent/good: 100%, fair: 50%, needs review/retired: 0% |
| Customer tier thresholds | signature: 10+ rentals & 90%+ on-time; member: 1+ rentals; new: 0 |
| OTP resend cooldown / daily cap | 45s / 5 per day |
| Guest checkout | **not allowed** — login required (decided) |
| Payment gateway | **Razorpay** for INR, Stripe for other display currencies |
| Checkout hold (unpaid order keeps its stock) | 30 min, then reconciled with the gateway and released (`checkoutHoldMinutes`) |
| Delivery methods | Standard ₹50 (3–5 days), Express ₹100 (1–2 days), India only (`BUSINESS_RULES.delivery`) |
| Multi-facility routing | not modeled — `facilityId` is set manually / via seed, no nearest-facility logic |

## API surface

See **[API_REFERENCE.md](./API_REFERENCE.md)** for full request/response
examples for every endpoint (auth headers, currency handling, checkout
flow, Stripe integration, etc.) — written for whoever builds the frontend
integration. The list below is just a quick index.

All routes are prefixed `/api`. Every list endpoint is paginated
(`?page=&pageSize=`, default 20/page, max 100).

### Auth (`/api/auth`)
`POST /sign-up`, `POST /verify-otp`, `POST /resend-otp`, `POST /sign-in`,
`POST /request-otp-login`, `POST /google` (Google sign-in — verifies a
Google ID token from the frontend), `POST /logout`,
`POST /logout-everywhere`, `GET /session`

### Catalog (public, currency-aware)
`GET /products`, `GET /products/:id`, `GET /products/:id/availability`,
`GET /occasions`, `GET /outfits`, `GET /outfits/:id`

### Cart, addresses, delivery (auth required)
`GET /cart`, `POST /cart/items`, `PATCH/DELETE /cart/items/:itemId`,
`POST/DELETE /cart/coupon`, `POST /cart/revalidate`, `POST /cart/merge`,
`GET/POST /addresses`, `PATCH/DELETE /addresses/:id`, `POST /addresses/:id/default`,
`GET /addresses/regions` (public), `GET /shipping/methods?addressId=|postalCode=`,
`GET /wishlist`, `PUT/DELETE /wishlist/:productId`

### Checkout, orders & payments (auth required)
`GET /checkout` (checkout gate), `POST /orders/preview`, `POST /orders` (needs
`Idempotency-Key` + `expectedTotalPaise`), `GET /orders`, `GET /orders/:id`,
`GET /orders/:id/status`, `POST /orders/:id/cancel`,
`POST /payments/razorpay/order`, `POST /payments/razorpay/verify`,
`POST /payments/razorpay/failure`, `POST /payments/confirm` (Stripe).
Deprecated: `POST /checkout` (compatibility shim for older shop builds).

### Webhooks (unauthenticated, signature-verified, raw body)
`POST /webhooks/razorpay`, `POST /webhooks/stripe`
(legacy paths `/payments/razorpay-webhook` and `/payments/webhook` still work)

### Console (operator/admin only)
`GET /console/garment-units`, `GET /console/garment-units/:id`,
`POST /console/garment-units/:id/transition`, `GET /console/lifecycle/counts`,
`GET/POST /console/laundry/batches`, `POST /console/laundry/batches/:id/advance`,
`GET /console/orders`, `GET /console/orders/:id`, `PATCH /console/orders/:id/status`,
`GET /console/customers`, `GET /console/customers/:id`,
`GET /console/delivery-jobs`, `PATCH /console/delivery-jobs/:id/courier`,
`PATCH /console/delivery-jobs/:id/complete`,
`GET /console/payments`, `POST /console/payments/order-items/:id/refund`,
`GET /console/analytics/:metric` (`utilization|revenue|turnaround|overdue`),
`GET /console/notifications`, `POST /console/notifications/:id/read`,
`GET/POST /console/coupons`, `PATCH /console/coupons/:id`

## What's intentionally out of scope for this pass

- Real SMS delivery (OTPs log to the server console unless `SMS_PROVIDER_API_KEY` is set and a provider is wired into `modules/auth/sms.ts`)
- Multi-facility routing logic (nearest-facility assignment)
- A review-submission endpoint (the `reviews` table + aggregate exist; only writing is unbuilt, matching the frontend's own read-only display)
