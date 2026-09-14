import { Router } from "express";
import { asyncHandler } from "../../../lib/asyncHandler";
import { requireAuth } from "../../../middleware/auth";
import { requireRole } from "../../../middleware/rbac";
import { prisma } from "../../../lib/prisma";

export const consoleNotificationsRouter = Router();
consoleNotificationsRouter.use(requireAuth, requireRole("operator", "admin"));

/**
 * Per-user read state via notification_reads (build spec §7.11 / §3): the
 * frontend's single global read/unread flag breaks the moment a second
 * operator opens the Concourse. `read` here is computed per requesting user.
 */
consoleNotificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const notifications = await prisma.notification.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
    const reads = await prisma.notificationRead.findMany({
      where: { userId: req.auth!.userId, notificationId: { in: notifications.map((n) => n.id) } },
      select: { notificationId: true },
    });
    const readSet = new Set(reads.map((r) => r.notificationId));

    res.json({
      items: notifications.map((n) => ({
        id: n.id,
        severity: n.severity,
        title: n.title,
        detail: n.detail,
        relatedType: n.relatedType,
        relatedId: n.relatedId,
        createdAt: n.createdAt,
        read: readSet.has(n.id),
      })),
      unreadCount: notifications.length - readSet.size,
    });
  })
);

consoleNotificationsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    await prisma.notificationRead.upsert({
      where: { notificationId_userId: { notificationId: req.params.id, userId: req.auth!.userId } },
      update: {},
      create: { notificationId: req.params.id, userId: req.auth!.userId },
    });
    res.status(204).end();
  })
);
