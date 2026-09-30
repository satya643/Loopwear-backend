import { randomInt } from "crypto";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { hashSecret, compareSecret } from "../../lib/password";
import { ApiError } from "../../lib/errors";
import { sendOtpSms } from "./sms";

const DAY_MS = 24 * 60 * 60 * 1000;

// Cryptographically random — Math.random() is predictable enough that an
// attacker observing codes could narrow down the next one.
function generateCode(): string {
  return String(randomInt(100000, 1000000));
}

/**
 * Issues a new OTP for `phone`, enforcing:
 *  - resend cooldown (build spec §4.4 / §7.6 — was completely missing)
 *  - a daily send cap per phone (§8.3 decision: cap prevents SMS-cost abuse)
 * One active OTP per phone; issuing a new one overwrites the old one, same
 * as the original in-memory store's behavior.
 */
export async function issueOtp(phone: string): Promise<void> {
  const existing = await prisma.otpCode.findUnique({ where: { phone } });
  const now = new Date();

  if (existing) {
    const secondsSinceLastSend = (now.getTime() - existing.lastSentAt.getTime()) / 1000;
    if (secondsSinceLastSend < env.otp.resendCooldownSeconds) {
      const waitSeconds = Math.ceil(env.otp.resendCooldownSeconds - secondsSinceLastSend);
      throw ApiError.tooManyRequests(`Please wait ${waitSeconds}s before requesting another code`);
    }

    const windowExpired = now.getTime() - existing.sendWindowStart.getTime() > DAY_MS;
    const sendCount = windowExpired ? 0 : existing.sendCount;
    if (sendCount >= env.otp.dailySendCap) {
      throw ApiError.tooManyRequests("Daily OTP limit reached for this phone number, please try again tomorrow");
    }

    const code = generateCode();
    await prisma.otpCode.update({
      where: { phone },
      data: {
        codeHash: await hashSecret(code),
        expiresAt: new Date(now.getTime() + env.otp.ttlMinutes * 60 * 1000),
        attempts: 0,
        lastSentAt: now,
        sendCount: sendCount + 1,
        sendWindowStart: windowExpired ? now : existing.sendWindowStart,
      },
    });
    await sendOtpSms(phone, code);
    return;
  }

  const code = generateCode();
  await prisma.otpCode.create({
    data: {
      phone,
      codeHash: await hashSecret(code),
      expiresAt: new Date(now.getTime() + env.otp.ttlMinutes * 60 * 1000),
      lastSentAt: now,
      sendCount: 1,
      sendWindowStart: now,
    },
  });
  await sendOtpSms(phone, code);
}

export async function consumeOtp(phone: string, code: string): Promise<void> {
  const record = await prisma.otpCode.findUnique({ where: { phone } });
  if (!record) throw ApiError.badRequest("No verification code was requested for this number");

  if (record.expiresAt < new Date()) {
    throw ApiError.badRequest("This code has expired, request a new one");
  }
  // Claim an attempt atomically *before* comparing: with a read-then-
  // increment, many parallel guesses could all read attempts < max and all
  // get compared, bypassing the limit.
  const claimed = await prisma.otpCode.updateMany({
    where: { phone, codeHash: record.codeHash, attempts: { lt: env.otp.maxAttempts } },
    data: { attempts: { increment: 1 } },
  });
  if (claimed.count === 0) {
    throw ApiError.tooManyRequests("Too many incorrect attempts, request a new code");
  }

  const ok = await compareSecret(code, record.codeHash);
  if (!ok) {
    const remaining = env.otp.maxAttempts - (record.attempts + 1);
    throw ApiError.badRequest(`Incorrect code${remaining > 0 ? `, ${remaining} attempt(s) left` : ""}`);
  }

  // deleteMany: a concurrent correct guess may already have consumed it.
  const consumed = await prisma.otpCode.deleteMany({ where: { phone, codeHash: record.codeHash } });
  if (consumed.count === 0) throw ApiError.badRequest("This code has already been used, request a new one");
}
