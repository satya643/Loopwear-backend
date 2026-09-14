import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateQuery } from "../../../middleware/validate";
import { paginationSchema } from "../../../lib/pagination";
import * as customersService from "./service";

export const consoleCustomersRouter = Router();
consoleCustomersRouter.use(requireAuth, requireRole("operator", "admin"));

const listQuerySchema = paginationSchema.extend({ q: z.string().optional() });

consoleCustomersRouter.get(
  "/",
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize, ...filters } = req.query as unknown as ReturnType<(typeof listQuerySchema)["parse"]>;
    res.json(await customersService.listCustomers(filters, { page, pageSize }));
  })
);

consoleCustomersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await customersService.getCustomer(req.params.id));
  })
);
