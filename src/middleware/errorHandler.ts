import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { ApiError } from "../lib/errors";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: { code: "not_found", message: `No route ${req.method} ${req.path}` } });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: { code: "validation_error", message: "Invalid request", details: err.flatten() },
    });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  return res.status(500).json({ error: { code: "internal_error", message: "Something went wrong" } });
}
