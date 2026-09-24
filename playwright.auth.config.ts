import { defineConfig } from "@playwright/test";
if (!process.env.TEST_AUTH_ORIGIN || !process.env.TEST_MAIL_ORIGIN || !process.env.TEST_AUTH_ADMIN_KEY) throw new Error("Run npm run test:auth to provision the isolated Auth service.");
export default defineConfig({
  testDir: "tests/auth-e2e", workers: 1, fullyParallel: false, timeout: 90_000,
  testMatch: process.env.TEST_CHAT ? "chat.spec.ts" : "accounts.spec.ts",
  // Auth traces would contain credentials and one-time links, even on failures.
  use: { baseURL: process.env.APP_ORIGIN, trace: "off", screenshot: "off", video: "off" },
  reporter: "list",
});
