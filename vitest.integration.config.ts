import { defineConfig } from "vitest/config";

/**
 * End-to-end tests of the HTTP API against a real Postgres database, with
 * only the Razorpay network calls mocked. They TRUNCATE every table, so
 * TEST_DATABASE_URL must point at a disposable database — never your dev DB:
 *
 *   TEST_DATABASE_URL=postgresql://…/loopwear_test npx prisma migrate deploy   # once, with DATABASE_URL=$TEST_DATABASE_URL
 *   TEST_DATABASE_URL=postgresql://…/loopwear_test npm run test:integration
 */
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) throw new Error("Set TEST_DATABASE_URL to a disposable database to run integration tests");
if (!/test/i.test(new URL(testDatabaseUrl).pathname)) {
  throw new Error("Refusing to run: TEST_DATABASE_URL's database name must contain 'test' (these tests truncate every table)");
}

export default defineConfig({
  test: {
    include: ["src/**/*.int.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: testDatabaseUrl,
      JWT_SECRET: "integration-test-secret",
      RAZORPAY_KEY_ID: "rzp_test_integration",
      RAZORPAY_KEY_SECRET: "integration_key_secret",
      RAZORPAY_WEBHOOK_SECRET: "integration_webhook_secret",
      RUN_JOBS_IN_PROCESS: "false",
      RATE_LIMIT_MAX_GENERAL_REQUESTS: "100000",
      RATE_LIMIT_MAX_CHECKOUT_REQUESTS: "100000",
    },
  },
});
