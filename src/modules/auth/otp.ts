import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { hashSecret, compareSecret } from "../../lib/password";
import { ApiError } from "../../lib/errors";
import { sendOtpSms } from "./sms";

const DAY_MS = 24 * 60 * 60 * 1000;

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
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
  if (record.attempts >= env.otp.maxAttempts) {
    throw ApiError.tooManyRequests("Too many incorrect attempts, request a new code");
  }

  const ok = await compareSecret(code, record.codeHash);
  if (!ok) {
    await prisma.otpCode.update({ where: { phone }, data: { attempts: { increment: 1 } } });
    const remaining = env.otp.maxAttempts - (record.attempts + 1);
    throw ApiError.badRequest(`Incorrect code${remaining > 0 ? `, ${remaining} attempt(s) left` : ""}`);
  }

  await prisma.otpCode.delete({ where: { phone } });
}
