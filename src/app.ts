import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "node:path";
import { env } from "./config/env";

import { optionalAuth } from "./middleware/auth";
import { resolveCurrency } from "./middleware/currency";
import { generalRateLimiter } from "./middleware/rateLimit";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

import { authRouter } from "./modules/auth/routes";
import { catalogRouter } from "./modules/catalog/routes";
import { outfitsRouter } from "./modules/outfits/routes";
import { cartRouter } from "./modules/cart/routes";
import { wishlistRouter } from "./modules/wishlist/routes";
import { checkoutRouter } from "./modules/checkout/routes";
import { ordersRouter } from "./modules/orders/routes";
import { paymentsRouter, paymentsWebhookRouter, webhooksRouter } from "./modules/payments/routes";
import { addressesRouter } from "./modules/addresses/routes";
import { shippingRouter } from "./modules/shipping/routes";

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
import { consoleCouponsRouter } from "./modules/console/coupons/routes";

export function createApp() {
  const app = express();

  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
  
  app.set("trust proxy", env.trustProxy);
  app.use(cors(env.corsOrigins.length > 0 ? { origin: env.corsOrigins } : undefined));
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  app.use("/api/webhooks", webhooksRouter);
  app.use("/api/payments", paymentsWebhookRouter);

  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use("/uploads", express.static(path.join(process.cwd(), "uploads")));

  app.use(optionalAuth, resolveCurrency);

  app.use("/api", generalRateLimiter);

  app.use("/api/auth", authRouter);

  app.use("/api", catalogRouter);
  app.use("/api/outfits", outfitsRouter);
  app.use("/api/cart", cartRouter);
  app.use("/api/wishlist", wishlistRouter);
  app.use("/api/checkout", checkoutRouter);
  app.use("/api/addresses", addressesRouter);
  app.use("/api/shipping", shippingRouter);
  app.use("/api/orders", ordersRouter);
  app.use("/api/payments", paymentsRouter);


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
  app.use("/api/console/coupons", consoleCouponsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
