import { env } from "../../config/env";

/**
 * Real SMS delivery is out of scope for this build pass — plug in a provider
 * (Twilio, MSG91, etc.) here using env.smsProviderApiKey. Without a key
 * configured, OTPs are logged to the server console so local/dev flows work.
 */
export async function sendOtpSms(phone: string, code: string): Promise<void> {
  if (!env.smsProviderApiKey) {
    // eslint-disable-next-line no-console
    console.log(`[dev-sms] OTP for ${phone}: ${code}`);
    return;
  }
  // TODO: call real SMS provider with env.smsProviderApiKey.
  throw new Error("SMS provider configured but sendOtpSms() is not implemented for it yet");
}
