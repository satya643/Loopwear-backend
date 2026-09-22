import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { validateQuery } from "../../../middleware/validate";
import { prisma } from "../../../lib/prisma";
import { paginationSchema } from "../../../lib/pagination";
import { paginatedResponse, toSkipTake } from "../../../lib/pagination";
import { refundDepositForOrderItem } from "../../payments/service";

export const consolePaymentsRouter = Router();
consolePaymentsRouter.use(requireAuth, requireRole("operator", "admin"));

const listQuerySchema = paginationSchema.extend({
  status: z.string().optional(),
  method: z.string().optional(),
});

consolePaymentsRouter.get(
  "/",
  validateQuery(listQuerySchema),
  asyncHandler(async (req, res) => {
    const { page, pageSize, status, method } = req.query as unknown as ReturnType<(typeof listQuerySchema)["parse"]>;
    const where: import("@prisma/client").Prisma.PaymentWhereInput = {};
    if (status) where.status = status as never;
    if (method) where.method = method as never;

    const { skip, take } = toSkipTake({ page, pageSize });
    const [rows, total] = await Promise.all([
      prisma.payment.findMany({
        where,
        include: { customer: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        skip,
        take,
      }),
      prisma.payment.count({ where }),
    ]);
    res.json(
      paginatedResponse(
        rows.map((p) => ({
          id: p.id,
          orderId: p.orderId,
          customerId: p.customerId,
          amountPaise: p.amountPaise,
          chargedAmountMinor: p.chargedAmountMinor,
          chargedCurrency: p.chargedCurrency,
          method: p.method,
          status: p.status,
          gateway: p.gateway,
          gatewayRef: p.gatewayRef,
          gatewayPaymentRef: p.gatewayPaymentRef,
          idempotencyKey: p.idempotencyKey,
          createdAt: p.createdAt,
          customer: { id: p.customer.id, name: p.customer.name },
          order: { id: p.orderId },
        })),
        total,
        { page, pageSize }
      )
    );
  })
);

/**
 * Operator-initiated deposit refund on a returned rental item. Kept under
 * the console, not the customer-facing payments router, since refund
 * decisions follow inspection (an operator action), not a customer request.
 */
consolePaymentsRouter.post(
  "/order-items/:id/refund",
  asyncHandler(async (req, res) => {
    const refund = await refundDepositForOrderItem(req.params.id, req.auth!.userId);
    res.json({ refund });
  })
);
