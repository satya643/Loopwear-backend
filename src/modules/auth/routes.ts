import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { validateBody } from "../../middleware/validate";
import { requireAuth } from "../../middleware/auth";
import { authRateLimiter } from "../../middleware/rateLimit";
import {
  signUpSchema,
  verifyOtpSchema,
  resendOtpSchema,
  signInSchema,
  requestOtpLoginSchema,
  continueWithGoogleSchema,
} from "./schemas";
import * as authService from "./service";

export const authRouter = Router();

function meta(req: import("express").Request) {
  return { ip: req.ip, userAgent: req.headers["user-agent"] ?? null };
}

authRouter.post(
  "/sign-up",
  authRateLimiter,
  validateBody(signUpSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.signUp(req.body);
    res.status(201).json(result);
  })
);

authRouter.post(
  "/verify-otp",
  authRateLimiter,
  validateBody(verifyOtpSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.verifyOtp(req.body.phone, req.body.code, meta(req));
    res.json(result);
  })
);

authRouter.post(
  "/resend-otp",
  authRateLimiter,
  validateBody(resendOtpSchema),
  asyncHandler(async (req, res) => {
    await authService.resendOtp(req.body.phone);
    res.status(204).end();
  })
);

authRouter.post(
  "/sign-in",
  authRateLimiter,
  validateBody(signInSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.signIn(req.body.email, req.body.password, meta(req));
    res.json(result);
  })
);

authRouter.post(
  "/request-otp-login",
  authRateLimiter,
  validateBody(requestOtpLoginSchema),
  asyncHandler(async (req, res) => {
    await authService.requestOtpLogin(req.body.phone);
    res.status(204).end();
  })
);

authRouter.post(
  "/google",
  authRateLimiter,
  validateBody(continueWithGoogleSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.continueWithGoogle(req.body.idToken, meta(req));
    res.json(result);
  })
);

authRouter.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    await authService.logout(req.auth!.sessionId);
    res.status(204).end();
  })
);

authRouter.post(
  "/logout-everywhere",
  requireAuth,
  asyncHandler(async (req, res) => {
    await authService.logoutEverywhere(req.auth!.userId);
    res.status(204).end();
  })
);

authRouter.get(
  "/session",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await authService.getSessionUser(req.auth!.userId);
    res.json({ user });
  })
);
