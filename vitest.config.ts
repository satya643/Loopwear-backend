import { defineConfig } from "vitest/config";

// Unit tests only — no database. Integration tests (*.int.test.ts) need a
// throwaway Postgres and run via `npm run test:integration`.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.int.test.ts", "node_modules/**", "dist/**"],
  },
});
