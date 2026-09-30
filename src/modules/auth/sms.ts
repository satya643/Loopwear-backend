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
 * Sends an SMS via Twilio. Falls back to logging to the console whenever
 * Twilio isn't fully configured yet — no provider key, no account
 * credentials, or (the state right after adding Twilio creds but before
 * buying a number) no sender number — so OTPs and order messages keep
 * working in dev without ever silently dropping one.
 */
export async function sendSms(phone: string, body: string): Promise<void> {
  const twilioReady = env.smsProviderApiKey && env.twilio.accountSid && env.twilio.authToken && env.twilio.fromNumber;

  if (!twilioReady) {
    if (env.smsProviderApiKey === "twilio" && env.twilio.accountSid && !env.twilio.fromNumber) {
      // eslint-disable-next-line no-console
      console.warn("[dev-sms] TWILIO_FROM_NUMBER is not set — falling back to console logging.");
    }
    // eslint-disable-next-line no-console
    console.log(`[dev-sms] to ${phone}: ${body}`);
    return;
  }

  await getTwilioClient().messages.create({ to: phone, from: env.twilio.fromNumber, body });
}

export async function sendOtpSms(phone: string, code: string): Promise<void> {
  await sendSms(phone, `Your LoopWear verification code is ${code}. It expires in ${env.otp.ttlMinutes} minutes.`);
}
