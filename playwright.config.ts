import { defineConfig } from "@playwright/test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const token = "isolated-playwright-token-".repeat(3);
const otherToken = "isolated-playwright-other-".repeat(3);
export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://127.0.0.1:3137", trace: "retain-on-failure" },
  reporter: [["list"], ["html", { open: "never" }]],
  webServer: {
    command: "npm run start -- --hostname 127.0.0.1 --port 3137",
    url: "http://127.0.0.1:3137/api/health/live",
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      APP_ORIGIN: "http://127.0.0.1:3137",
      AUTH_PROVIDER: "api-key",
      AI_CHAT_ENABLED: "false",
      EVE_DEV: "",
      VERCEL_ENV: "production",
      DATA_PROVIDER: "sqlite",
      SQLITE_PATH: ".data/e2e.sqlite",
      UPLOAD_STORAGE_PROVIDER: "local",
      UPLOAD_LOCAL_ROOT: resolve(".data/e2e-uploads"),
      APP_API_KEYS: JSON.stringify([
        { sha256: createHash("sha256").update(token).digest("hex"), tenant: "e2e", subject: "browser", scopes: ["records:read", "records:write", "uploads:read", "uploads:write", "uploads:download"] },
        { sha256: createHash("sha256").update(otherToken).digest("hex"), tenant: "e2e", subject: "other-browser", scopes: ["uploads:read", "uploads:write"] },
      ]),
    },
  },
});
