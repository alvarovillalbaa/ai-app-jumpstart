import { defineConfig } from "@playwright/test";

if (!process.env.TEST_UPLOAD_SCAN_ORIGIN || !process.env.TEST_UPLOAD_SCAN_CONTROL) {
  throw new Error("Use npm run test:upload-scans to start the isolated app and scanner fixture.");
}
export default defineConfig({
  testDir: "tests/upload-e2e",workers: 1,fullyParallel: false,retries: 0,
  use: { baseURL: process.env.TEST_UPLOAD_SCAN_ORIGIN,trace: "off",screenshot: "off",video: "off" },
  reporter: "list",
});
