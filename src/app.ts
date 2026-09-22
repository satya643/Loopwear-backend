import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";

import { optionalAuth } from "./middleware/auth";
import { resolveCurrency } from "./middleware/currency";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

import { authRouter } from "./modules/auth/routes";
import { catalogRouter } from "./modules/catalog/routes";
import { outfitsRouter } from "./modules/outfits/routes";
import { cartRouter } from "./modules/cart/routes";
import { wishlistRouter } from "./modules/wishlist/routes";
import { checkoutRouter } from "./modules/checkout/routes";
import { ordersRouter } from "./modules/orders/routes";
import { paymentsRouter, paymentsWebhookRouter } from "./modules/payments/routes";

import { inventoryRouter } from "./modules/console/inventory/routes";
import { laundryRouter } from "./modules/console/laundry/routes";
import { consoleOrdersRouter } from "./modules/console/orders/routes";
import { consoleCustomersRouter } from "./modules/console/customers/routes";
import { consoleDeliveryRouter } from "./modules/console/delivery/routes";
import { consolePaymentsRouter } from "./modules/console/payments/routes";
import { consoleAnalyticsRouter } from "./modules/console/analytics/routes";
import { consoleNotificationsRouter } from "./modules/console/notifications/routes";
import { consoleProductsRouter } from "./modules/console/products/routes";
import { consoleCategoriesRouter } from "./modules/console/categories/routes";
import { consoleCouriersRouter } from "./modules/console/couriers/routes";
import { consoleFacilitiesRouter } from "./modules/console/facilities/routes";
import { consoleUploadsRouter } from "./modules/console/uploads/routes";
import { consoleOccasionTilesRouter } from "./modules/console/occasionTiles/routes";

export function createApp() {
  const app = express();

  // Default helmet() sends Cross-Origin-Resource-Policy: same-origin, which
  // browsers use to BLOCK loading any resource from a different origin —
  // including this server's own /uploads images requested via <img src="…">
  // from the admin panel (:3002) or shop (:3000), since those are different
  // ports = different origins. curl never enforces this (only browsers do),
  // which is why this silently broke every uploaded image in an actual
  // browser tab. This is a public API meant to be embedded cross-origin, so
  // that policy is loosened deliberately here, not disabled everywhere.
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  app.use(cors());
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  // Stripe webhook needs the raw body for signature verification — must be
  // mounted before express.json() below. See modules/payments/routes.ts.
  app.use("/api/payments", paymentsWebhookRouter);

  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Serves whatever lib/imageStorage.ts's local-disk fallback has saved —
  // only reachable when Cloudinary isn't configured or errors out on a
  // given upload (see console/uploads/routes.ts). Public/unauthenticated,
  // same as any Cloudinary URL would be.
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

  // Resolves req.auth (if a valid bearer token is present) and req.currency
  // for every request; individual routers still enforce requireAuth/RBAC.
  app.use(optionalAuth, resolveCurrency);

  // authRateLimiter is applied per-route inside authRouter (only to
  // credential-attempt endpoints), not to the whole router — see routes.ts.
  app.use("/api/auth", authRouter);
  // catalogRouter defines its own /products and /occasions paths internally.
  app.use("/api", catalogRouter);
  app.use("/api/outfits", outfitsRouter);
  app.use("/api/cart", cartRouter);
  app.use("/api/wishlist", wishlistRouter);
  app.use("/api/checkout", checkoutRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/payments", paymentsRouter);

  // inventoryRouter defines its own /garment-units and /lifecycle paths internally.
  app.use("/api/console", inventoryRouter);
  app.use("/api/console/laundry", laundryRouter);
  app.use("/api/console/orders", consoleOrdersRouter);
  app.use("/api/console/customers", consoleCustomersRouter);
  app.use("/api/console/delivery-jobs", consoleDeliveryRouter);
  app.use("/api/console/payments", consolePaymentsRouter);
  app.use("/api/console/analytics", consoleAnalyticsRouter);
  app.use("/api/console/notifications", consoleNotificationsRouter);
  app.use("/api/console/products", consoleProductsRouter);
  app.use("/api/console/categories", consoleCategoriesRouter);
  app.use("/api/console/couriers", consoleCouriersRouter);
  app.use("/api/console/facilities", consoleFacilitiesRouter);
  app.use("/api/console/uploads", consoleUploadsRouter);
  app.use("/api/console/occasion-tiles", consoleOccasionTilesRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
