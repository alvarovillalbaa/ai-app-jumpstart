import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const auth = process.env.TEST_AUTH_ORIGIN!;
const adminHeaders = { authorization: `Bearer ${process.env.TEST_AUTH_ADMIN_KEY!}`, apikey: process.env.SUPABASE_PUBLISHABLE_KEY! };
const publicHeaders = { apikey: process.env.SUPABASE_PUBLISHABLE_KEY! };
const password = "Fixture-only-password-42!";
async function atPath(page: Page, path: string) {
  // Report only paths on failure, never one-time tokens in email-link queries.
  await expect.poll(() => new URL(page.url()).pathname).toBe(path);
}
async function confirmedUser(request: APIRequestContext, email: string) {
  const response = await request.post(`${auth}/auth/v1/admin/users`, { headers: adminHeaders, data: { email, password, email_confirm: true } });
  expect(response.status()).toBe(200);
}
async function tokenFor(request: APIRequestContext, email: string, pass = password) {
  const response = await request.post(`${auth}/auth/v1/token?grant_type=password`, { headers: publicHeaders, data: { email, password: pass } });
  expect(response.status()).toBe(200); return (await response.json()).access_token as string;
}
async function login(page: Page, email: string, pass = password) {
  await page.goto("/login"); await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(pass);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await atPath(page, "/account");
  await expect(page.getByText(email, { exact: true })).toBeVisible();
}
async function emailLink(request: APIRequestContext, email: string) {
  let id = "";
  await expect.poll(async () => {
    const response = await request.get(`${process.env.TEST_MAIL_ORIGIN}/api/v1/messages`);
    const data = await response.json();
    const message = data.messages?.find((item: { To: { Address: string }[] }) => item.To.some(to => to.Address === email));
    id = message?.ID ?? ""; return !!id;
  }, { timeout: 15_000 }).toBe(true);
  const response = await request.get(`${process.env.TEST_MAIL_ORIGIN}/api/v1/message/${id}`);
  const message = await response.json();
  const link = String(message.HTML).match(/href="([^"]+)"/)?.[1]?.replaceAll("&amp;", "&");
  if (!link || new URL(link).origin !== auth) throw new Error("Local Auth did not send an expected verification link.");
  return link;
}

test("signup email, PKCE callback, private records, cross-user API denial and logout", async ({ page, request }) => {
  const email = `signup-${randomUUID()}@example.test`;
  await page.goto("/signup");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("Check your email");
  await page.goto(await emailLink(request, email));
  await atPath(page, "/account");
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load records" }).click();
  await page.getByLabel("Title", { exact: true }).fill("Private account record");
  const created = page.waitForResponse(response => response.url().endsWith("/api/v1/records") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Create record" }).click();
  const recordResponse = await created; expect(recordResponse.status()).toBe(201); const record = await recordResponse.json();
  await page.reload(); await page.getByRole("button", { name: "Load records" }).click();
  await expect(page.getByRole("heading", { name: record.title })).toBeVisible();
  const other = `other-${randomUUID()}@example.test`;
  await confirmedUser(request, other); const token = await tokenFor(request, other);
  const denied = await request.get(`/api/v1/records/${record.id}`, { headers: { authorization: `Bearer ${token}` } });
  expect(denied.status()).toBe(404);
  const mcp = new Client({ name: "auth-isolation", version: "1" });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", process.env.APP_ORIGIN!), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    expect((await mcp.callTool({ name: "records_get", arguments: { id: record.id } })).isError).toBe(true);
  } finally { await mcp.close(); }
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await atPath(page, "/login");
  await page.goto("/account"); await atPath(page, "/login");
  await login(page, other); await page.getByRole("button", { name: "Load records" }).click();
  await expect(page.getByText("No records yet.", { exact: false })).toBeVisible();
  await expect(page.getByText(record.title)).toHaveCount(0);
});

test("revoked sessions and forged access tokens cannot read the API", async ({ request }) => {
  const email = `revoke-${randomUUID()}@example.test`; await confirmedUser(request, email);
  const token = await tokenFor(request, email);
  expect((await request.get("/api/v1/records", { headers: { authorization: `Bearer ${token}` } })).status()).toBe(200);
  const logout = await request.post(`${auth}/auth/v1/logout?scope=local`, { headers: { ...publicHeaders, authorization: `Bearer ${token}` } });
  expect(logout.status()).toBe(204);
  expect((await request.get("/api/v1/records", { headers: { authorization: `Bearer ${token}` } })).status()).toBe(401);
  const parts = token.split(".");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString()); claims.sub = randomUUID();
  parts[1] = Buffer.from(JSON.stringify(claims)).toString("base64url");
  expect((await request.get("/api/v1/records", { headers: { authorization: `Bearer ${parts.join(".")}` } })).status()).toBe(401);
});

test("password recovery email and old-password rejection", async ({ page, request }) => {
  const email = `recover-${randomUUID()}@example.test`; await confirmedUser(request, email);
  await page.goto("/recover"); await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByRole("button", { name: "Reset password", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("If this account exists");
  await page.goto(await emailLink(request, email));
  await atPath(page, "/account/password");
  await expect(page.getByRole("heading", { name: "Update password" })).toBeVisible();
  const replacement = "New-fixture-password-74!";
  await page.getByLabel("Password", { exact: true }).fill(replacement); await page.getByLabel("Confirm password").fill(replacement);
  await page.getByRole("button", { name: "Update password", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Your password has been updated.");
  await page.goto("/account"); await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await atPath(page, "/login");
  await page.getByLabel("Email", { exact: true }).fill(email); await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await expect(page.getByRole("main").getByRole("alert")).toContainText("Sign-in failed");
  await login(page, email, replacement);
});

test("confirmation requires a user action, rejects replay and clamps return paths", async ({ page, request }) => {
  const email = `confirm-${randomUUID()}@example.test`;
  const response = await request.post(`${auth}/auth/v1/admin/generate_link`, { headers: adminHeaders, data: { type: "signup", email, password } });
  expect(response.status()).toBe(200); const link = await response.json();
  const tokenHash = link.hashed_token ?? link.properties?.hashed_token;
  expect(typeof tokenHash).toBe("string");
  await page.goto(`/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=email&next=//evil.example`);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await atPath(page, "/account");
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  const replay = await request.post("/auth/verify", { headers: { origin: process.env.APP_ORIGIN! }, data: { token_hash: tokenHash, type: "email" } });
  expect(replay.status()).toBe(400);
  const crossOrigin = await request.post("/auth/verify", { headers: { origin: "https://evil.example" }, data: { token_hash: tokenHash, type: "email" } });
  expect(crossOrigin.status()).toBe(403);
});
