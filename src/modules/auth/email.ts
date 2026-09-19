import { env } from "../../config/env";

/**
 * Real email delivery is out of scope for this build pass — plug in a provider
 * (SendGrid, SES, Postmark, etc.) here using env.emailProviderApiKey. Without
 * a key configured, the reset link is logged to the server console so
 * local/dev flows stay testable without a real email account.
 */
export async function sendPasswordResetEmail(email: string, resetUrl: string): Promise<void> {
  if (!env.emailProviderApiKey) {
    // eslint-disable-next-line no-console
    console.log(`[dev-email] Password reset link for ${email}: ${resetUrl}`);
    return;
  }
  // TODO: call real email provider with env.emailProviderApiKey.
  throw new Error("Email provider configured but sendPasswordResetEmail() is not implemented for it yet");
}
