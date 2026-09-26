import { test, expect } from "@playwright/test";
test("unknown pages show a useful 404", async ({ page }) => {
  const response = await page.goto("/a-page-that-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
  await page.getByRole("link", { name: "Open records" }).click();
  await expect(page).toHaveURL(/\/records$/);
});
test("workspace navigation stays usable by keyboard and on mobile when chat is disabled", async ({ page }) => {
  await page.goto("/records");
  await expect(page).toHaveTitle("Records | AI App Jumpstart");
  const desktop = page.getByRole("navigation", { name: "Workspace" });
  await expect(desktop.getByRole("link", { name: "Records" })).toHaveAttribute("aria-current", "page");
  await expect(desktop.getByRole("link", { name: "Chat" })).toHaveCount(0);
  await expect(desktop.getByRole("link", { name: "Account" })).toHaveCount(0);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#workspace-content")).toBeFocused();

  await page.getByRole("combobox", { name: "Theme" }).selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Theme" })).toHaveValue("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.locator("header details");
  await menu.locator("summary").click();
  await expect(menu).toHaveAttribute("open", "");
  await menu.getByRole("combobox", { name: "Theme" }).selectOption("light");
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "dark" });
  await menu.getByRole("combobox", { name: "Theme" }).selectOption("system");
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await menu.getByRole("link", { name: "Records" }).click();
  await expect(menu).not.toHaveAttribute("open", "");
});
test("authenticated browser creation survives a reload and API deletion", async ({ page, request }) => {
  const token = "isolated-playwright-token-".repeat(3);
  const title = `Browser record ${crypto.randomUUID()}`;
  const headers = { authorization: `Bearer ${token}` };
  await page.goto("/records");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Content", { exact: true }).fill("Saved through the real database.");
  await page.getByRole("button", { name: "Create record" }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Access token")).toHaveValue("");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  const response = await request.get("/api/v1/records?limit=100", { headers });
  expect(response.ok()).toBeTruthy();
  const row = (await response.json()).items.find((r: { title: string }) => r.title === title);
  const deleted = await request.delete(`/api/v1/records/${row.id}?revision=${row.revision}`, { headers });
  expect(deleted.status()).toBe(204);
});
test("health and access control are observable", async ({ request }) => {
  const live = await request.get("/api/health/live");
  expect(live.status()).toBe(200);
  expect(live.headers()["x-content-type-options"]).toBe("nosniff");
  expect(live.headers()["content-security-policy"]).toContain("object-src 'none'");
  const page = await request.get("/records");
  expect(page.headers()["referrer-policy"]).toBe("no-referrer");
  expect(page.headers()["x-frame-options"]).toBe("DENY");
  expect(page.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(page.headers()["content-security-policy"]).toContain("object-src 'none'");
  expect((await request.get("/api/health/ready")).status()).toBe(200);
  expect((await request.get("/api/v1/records")).status()).toBe(401);
});
test("per-request CSP nonces allow hydration and theme changes", async ({ page }) => {
  await page.addInitScript(() => {
    const target = window as Window & { cspViolations?: string[] };
    target.cspViolations = [];
    window.addEventListener("securitypolicyviolation", event => target.cspViolations?.push(`${event.effectiveDirective}: ${event.blockedURI} ${event.sourceFile}:${event.lineNumber}`));
  });
  const first = await page.goto("/records");
  const policy = first?.headers()["content-security-policy"] ?? "";
  const nonce = policy.match(/script-src[^;]*'nonce-([^']+)'/)?.[1];
  expect(nonce).toBeTruthy();
  expect(policy).toContain("style-src-attr 'unsafe-inline'");
  expect(await page.locator("script[nonce]").count()).toBeGreaterThan(0);
  await page.getByRole("combobox", { name: "Theme" }).selectOption("dark");
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => (window as Window & { cspViolations?: string[] }).cspViolations)).toEqual([]);
  const second = await page.reload();
  expect(second?.headers()["content-security-policy"]).toContain("script-src");
  expect(second?.headers()["content-security-policy"]).not.toContain(`'nonce-${nonce}'`);
  await expect(page.locator("html")).toHaveClass(/dark/);
  expect(await page.evaluate(() => (window as Window & { cspViolations?: string[] }).cspViolations)).toEqual([]);
});
test("compiled Eve keeps production session operations closed when account chat is disabled", async ({ request }) => {
  expect((await request.get("/eve/v1/health")).status()).toBe(200);
  const headers = { authorization: `Bearer ${"isolated-playwright-token-".repeat(3)}` };
  expect((await request.get("/eve/v1/info", { headers })).status()).toBe(401);
  for (const path of ["/eve/v1/session", "/eve/v1/session/missing", ...["cancel", "clear", "compact", "reset"].map(action => `/eve/v1/session/missing/${action}`)]) {
    expect((await request.post(path, { headers, data: { message: "No model call should start" } })).status()).toBe(401);
  }
  expect((await request.get("/eve/v1/session/missing/stream", { headers })).status()).toBe(401);
  expect((await request.get("/eve/v1/session/missing/subagents/call/child/stream", { headers })).status()).toBe(401);
});
