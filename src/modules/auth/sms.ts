import twilio from "twilio";
import { env } from "../../config/env";

let client: ReturnType<typeof twilio> | null = null;

function getTwilioClient() {
  if (!client) {
    if (!env.twilio.accountSid || !env.twilio.authToken) {
      throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not configured");
    }
    client = twilio(env.twilio.accountSid, env.twilio.authToken);
  }
  return client;
}

/**
 * Sends the OTP over SMS via Twilio. Falls back to logging to the console
 * whenever Twilio isn't fully configured yet — no provider key, no
 * account credentials, or (the state right after adding Twilio creds but
 * before buying a number) no sender number — so sign-up/login OTP keeps
 * working in dev without ever silently dropping a code.
 */
export async function sendOtpSms(phone: string, code: string): Promise<void> {
  const twilioReady = env.smsProviderApiKey && env.twilio.accountSid && env.twilio.authToken && env.twilio.fromNumber;

  if (!twilioReady) {
    if (env.smsProviderApiKey === "twilio" && env.twilio.accountSid && !env.twilio.fromNumber) {
      // eslint-disable-next-line no-console
      console.warn("[dev-sms] TWILIO_FROM_NUMBER is not set — falling back to console logging.");
    }
    // eslint-disable-next-line no-console
    console.log(`[dev-sms] OTP for ${phone}: ${code}`);
    return;
  }

  await getTwilioClient().messages.create({
    to: phone,
    from: env.twilio.fromNumber,
    body: `Your LoopWear verification code is ${code}. It expires in ${env.otp.ttlMinutes} minutes.`,
  });
}
