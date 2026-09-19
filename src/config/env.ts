import "dotenv/config";

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: optionalInt("PORT", 4000),
  appBaseUrl: process.env.APP_BASE_URL ?? "http://localhost:4000",

  databaseUrl: required("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/loopwear"),

  // No fallback: a missing JWT secret must fail loudly at startup, not
  // silently sign tokens with a guessable default (security requirement).
  jwtSecret: required("JWT_SECRET"),
  jwtTtlDays: optionalInt("JWT_TTL_DAYS", 7),

  otp: {
    ttlMinutes: optionalInt("OTP_TTL_MINUTES", 10),
    maxAttempts: optionalInt("OTP_MAX_ATTEMPTS", 5),
    resendCooldownSeconds: optionalInt("OTP_RESEND_COOLDOWN_SECONDS", 45),
    dailySendCap: optionalInt("OTP_DAILY_SEND_CAP", 5),
  },

  passwordReset: {
    ttlMinutes: optionalInt("PASSWORD_RESET_TTL_MINUTES", 30),
    resendCooldownSeconds: optionalInt("PASSWORD_RESET_RESEND_COOLDOWN_SECONDS", 60),
  },

  smsProviderApiKey: process.env.SMS_PROVIDER_API_KEY ?? "",
  emailProviderApiKey: process.env.EMAIL_PROVIDER_API_KEY ?? "",

  // Where the frontend lives — used to build the password-reset link sent by
  // email (the backend has no reset-password UI of its own).
  frontendBaseUrl: process.env.FRONTEND_BASE_URL ?? "http://localhost:3000",

  google: {
    // Only the client ID is needed: it's the audience we verify Google ID
    // tokens against, not a secret.
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
  },

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? "",
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "",
  },

  currency: {
    base: process.env.BASE_CURRENCY ?? "INR",
    fxApiKey: process.env.FX_RATE_API_KEY ?? "",
    fxApiUrl: process.env.FX_RATE_API_URL ?? "https://api.exchangerate.host/latest",
  },

  rateLimit: {
    windowMinutes: optionalInt("RATE_LIMIT_WINDOW_MINUTES", 15),
    maxAuthRequests: optionalInt("RATE_LIMIT_MAX_AUTH_REQUESTS", 20),
    // Broader than the auth-specific limiter: covers checkout, cart, and
    // console endpoints, which previously had no throttling at all (a
    // scripted client could hammer /api/checkout — each call creates a real
    // Stripe PaymentIntent — or spam console list endpoints, unthrottled).
    maxGeneralRequests: optionalInt("RATE_LIMIT_MAX_GENERAL_REQUESTS", 300),
  },
};
