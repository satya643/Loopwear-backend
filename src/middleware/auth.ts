import type { NextFunction, Request, Response } from "express";
import { verifySessionToken } from "../lib/jwt";
import { prisma } from "../lib/prisma";
import { ApiError } from "../lib/errors";
import { asyncHandler } from "../lib/asyncHandler";

function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return null;
}

/**
 * Verifies the JWT AND checks the session hasn't been revoked (logout /
 * logout-everywhere / account-compromise response) or expired server-side —
 * a pure stateless JWT can't support revocation, so every request pays one
 * indexed lookup on sessions.id. Closes build spec §4.6.
 */
async function loadAuth(req: Request) {
  const token = extractToken(req);
  if (!token) return null;

  let payload;
  try {
    payload = verifySessionToken(token);
  } catch {
    return null;
  }

  const session = await prisma.session.findUnique({ where: { id: payload.sessionId } });
  if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

  return { userId: payload.sub, sessionId: payload.sessionId, role: payload.role };
}

export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const auth = await loadAuth(req);
  if (!auth) throw ApiError.unauthorized();
  req.auth = auth;
  next();
});

export const optionalAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const auth = await loadAuth(req);
  if (auth) req.auth = auth;
  next();
});
