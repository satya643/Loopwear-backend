import type { NextFunction, Request, Response } from "express";
import type { Role } from "@prisma/client";
import { ApiError } from "../lib/errors";

/**
 * Enforces role server-side. Every /api/console/* route must use this —
 * the frontend's Concourse has no auth check at all today (build spec §7.1).
 */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.auth) throw ApiError.unauthorized();
    if (!roles.includes(req.auth.role)) throw ApiError.forbidden();
    next();
  };
}
