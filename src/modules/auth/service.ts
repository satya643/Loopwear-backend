import { OAuth2Client } from "google-auth-library";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { hashSecret, compareSecret } from "../../lib/password";
import { signSessionToken } from "../../lib/jwt";
import { ApiError } from "../../lib/errors";
import { issueOtp, consumeOtp } from "./otp";
import type { User } from "@prisma/client";

const googleClient = new OAuth2Client(env.google.clientId);

async function createSession(user: User, meta: { ip?: string | null; userAgent?: string | null }) {
  const session = await prisma.session.create({
    data: {
      userId: user.id,
      expiresAt: new Date(Date.now() + env.jwtTtlDays * 24 * 60 * 60 * 1000),
      ip: meta.ip ?? undefined,
      userAgent: meta.userAgent ?? undefined,
    },
  });
  const token = signSessionToken({ sub: user.id, sessionId: session.id, role: user.role });
  return { token, session };
}

function publicUser(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    verified: user.verified,
    country: user.country,
    preferredCurrency: user.preferredCurrency,
  };
}

/**
 * Fixes build spec §4.2 / §7.4: re-signing-up with an existing *unverified*
 * email no longer silently overwrites the password hash with no rate limit.
 * Instead it updates the pending account's details and re-sends the OTP,
 * subject to the same cooldown/daily-cap as any other resend.
 */
export async function signUp(input: { name: string; email: string; phone: string; password: string }) {
  const existingByEmail = await prisma.user.findUnique({ where: { email: input.email } });
  if (existingByEmail?.verified) {
    throw ApiError.conflict("An account with this email already exists");
  }

  const existingByPhone = await prisma.user.findUnique({ where: { phone: input.phone } });
  if (existingByPhone?.verified && existingByPhone.id !== existingByEmail?.id) {
    throw ApiError.conflict("An account with this phone number already exists");
  }

  const passwordHash = await hashSecret(input.password);

  const user = existingByEmail
    ? await prisma.user.update({
        where: { id: existingByEmail.id },
        data: { name: input.name, phone: input.phone, passwordHash },
      })
    : await prisma.user.create({
        data: { name: input.name, email: input.email, phone: input.phone, passwordHash },
      });

  await issueOtp(user.phone!);
  return { userId: user.id };
}

/**
 * Shared verification endpoint for two purposes, distinguished by the
 * target user's current state: an unverified account completes signup;
 * an already-verified account is doing a phone-OTP login.
 */
export async function verifyOtp(phone: string, code: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) throw ApiError.badRequest("No account found for this phone number");

  await consumeOtp(phone, code);

  const verifiedUser = user.verified ? user : await prisma.user.update({ where: { id: user.id }, data: { verified: true } });

  const { token } = await createSession(verifiedUser, meta);
  return { token, user: publicUser(verifiedUser) };
}

export async function resendOtp(phone: string) {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user) throw ApiError.badRequest("No account found for this phone number");
  await issueOtp(phone);
}

export async function signIn(email: string, password: string, meta: { ip?: string | null; userAgent?: string | null }) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !user.passwordHash) throw ApiError.unauthorized("Invalid email or password");
  if (!user.verified) throw ApiError.forbidden("Please verify your account before signing in");

  const ok = await compareSecret(password, user.passwordHash);
  if (!ok) throw ApiError.unauthorized("Invalid email or password");

  const { token } = await createSession(user, meta);
  return { token, user: publicUser(user) };
}

export async function requestOtpLogin(phone: string) {
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user || !user.verified) throw ApiError.unauthorized("No verified account found for this phone number");
  await issueOtp(phone);
}

export async function logout(sessionId: string) {
  await prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
}

export async function logoutEverywhere(userId: string) {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function continueWithGoogle(idToken: string, meta: { ip?: string | null; userAgent?: string | null }) {
  if (!env.google.clientId) {
    throw ApiError.badRequest("Google sign-in is not connected yet");
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: env.google.clientId });
    payload = ticket.getPayload();
  } catch {
    throw ApiError.unauthorized("Invalid Google token");
  }

  if (!payload?.email || !payload.email_verified) {
    throw ApiError.unauthorized("Invalid Google token");
  }

  const email = payload.email.toLowerCase();
  const googleId = payload.sub;

  let user = await prisma.user.findUnique({ where: { googleId } });

  if (!user) {
    const existingByEmail = await prisma.user.findUnique({ where: { email } });
    user = existingByEmail
      ? await prisma.user.update({
          where: { id: existingByEmail.id },
          data: { googleId, verified: true },
        })
      : await prisma.user.create({
          data: {
            name: payload.name ?? email.split("@")[0],
            email,
            googleId,
            verified: true,
          },
        });
  }

  const { token } = await createSession(user, meta);
  return { token, user: publicUser(user) };
}

export async function getSessionUser(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw ApiError.unauthorized();
  return publicUser(user);
}
