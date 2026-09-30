import { env } from "../../config/env";

/**
 * Real email delivery is out of scope for this build pass — plug in a provider
 * (SendGrid, SES, Postmark, etc.) here using env.emailProviderApiKey. Without
 * a key configured, messages are logged to the server console so local/dev
 * flows stay testable without a real email account.
 */
export async function sendEmail(to: string, subject: string, text: string): Promise<void> {
  if (!env.emailProviderApiKey) {
    // eslint-disable-next-line no-console
    console.log(`[dev-email] to ${to} — ${subject}\n${text}`);
    return;
  }
  // TODO: call real email provider with env.emailProviderApiKey.
  throw new Error("Email provider configured but sendEmail() is not implemented for it yet");
}

export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {
  await sendEmail(email, "Reset your LoopWear password", `Reset your password: ${resetUrl}`);
}
