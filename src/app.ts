import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";

import { optionalAuth } from "./middleware/auth";
import { resolveCurrency } from "./middleware/currency";
import { authRateLimiter } from "./middleware/rateLimit";
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

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(cors());
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  // Stripe webhook needs the raw body for signature verification — must be
  // mounted before express.json() below. See modules/payments/routes.ts.
  app.use("/api/payments", paymentsWebhookRouter);

  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));

  // Resolves req.auth (if a valid bearer token is present) and req.currency
  // for every request; individual routers still enforce requireAuth/RBAC.
  app.use(optionalAuth, resolveCurrency);

  app.use("/api/auth", authRateLimiter, authRouter);
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
