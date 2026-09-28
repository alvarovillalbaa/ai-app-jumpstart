import { test,expect,type APIRequestContext,type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "eve/client";
import { encodeReviewedUploadMessage } from "../../lib/uploads/chat-reference";
import { runHostedSmoke } from "../../scripts/smoke-hosted.mjs";
import { auditAccessibility } from "../helpers/accessibility";

const auth = process.env.TEST_AUTH_ORIGIN!,password = "Fixture-only-password-42!";
const name = "<b>café notes< b>.txt",text = "PRIVATE-SOURCE café 東京\nExact second line.\n";
async function user(request: APIRequestContext) {
  const email = `chat-upload-${randomUUID()}@example.test`;
  const created = await request.post(`${auth}/auth/v1/admin/users`,{ headers: { authorization: `Bearer ${process.env.TEST_AUTH_ADMIN_KEY!}`,apikey: process.env.SUPABASE_PUBLISHABLE_KEY! },
    data: { email,password,email_confirm: true } });expect(created.status()).toBe(200);
  const response = await request.post(`${auth}/auth/v1/token?grant_type=password`,{ headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY! },data: { email,password } });
  expect(response.status()).toBe(200);return { email,token: (await response.json()).access_token as string };
}
const headers = (token: string) => ({ authorization: `Bearer ${token}` });
test("portable hosted upload smoke verifies scanner-backed private bytes and cleanup",async ({ request }) => {
  const alice = await user(request),bob = await user(request);
  const result = await runHostedSmoke({ url: process.env.APP_ORIGIN!,token: alice.token,otherToken: bob.token,uploadDownload: true });
  expect(result.uploadId).toMatch(/^[0-9a-f-]{36}$/i);
});
async function login(page: Page,email: string) {
  await page.goto("/login?next=/s");await page.getByLabel("Email",{ exact: true }).fill(email);await page.getByLabel("Password",{ exact: true }).fill(password);
  await page.getByRole("button",{ name: "Sign in",exact: true }).click();await expect.poll(() => new URL(page.url()).pathname).toBe("/s");
}
async function upload(request: APIRequestContext,token: string) {
  const response = await request.post("/api/v1/uploads",{ headers: { ...headers(token),"content-type": "application/octet-stream","x-upload-name": encodeURIComponent(name),"x-upload-media-type": "text/plain" },data: Buffer.from(text) });
  expect(response.status()).toBe(201);const row = await response.json();
  const approved = await request.put(`/api/v1/uploads/${row.id}/review`,{ headers: headers(token),data: { sha256: row.sha256,revision: 0,approved: true } });
  expect(approved.status()).toBe(200);const review = await approved.json();
  return { id: row.id,name,sha256: row.sha256,reviewRevision: review.revision as number };
}
async function choose(page: Page,id: string) {
  await page.getByRole("button",{ name: "Choose reviewed file" }).click();await page.getByLabel("File to reference").selectOption(id);
  await page.getByRole("button",{ name: "Use file",exact: true }).click();await expect(page.getByRole("button",{ name: "Remove file reference" })).toBeEnabled();
}
async function send(page: Page,message: string) {
  const input = page.getByPlaceholder("Send a message…");await expect(input).toBeEnabled();await input.fill(message);await input.press("Enter");
}
async function settle(page: Page,request: APIRequestContext,token: string,count: number) {
  await expect(page.getByRole("button",{ name: "Stop",exact: true })).toHaveCount(0,{ timeout: 30_000 });
  await expect.poll(async () => (await request.get("/api/v1/usage",{ headers: headers(token) })).json(),{ timeout: 30_000 })
    .toMatchObject({ chargedMicros: count*20,reservedMicros: 0,active: 0,unknownCosts: count });
}

test("real owner picks a reference, approves an exact native read, reloads it and must approve again",async ({ page,request }) => {
  const alice = await user(request),bob = await user(request),reference = await upload(request,alice.token);
  const before = await (await request.get(`/api/v1/uploads/${reference.id}`,{ headers: headers(alice.token) })).json();
  await login(page,alice.email);await choose(page,reference.id);await auditAccessibility(page,"selected reviewed file");
  await send(page,"Read this file and preserve its text.");
  await expect(page.getByRole("button",{ name: "Approve",exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button",{ name: "Approve",exact: true }).scrollIntoViewIfNeeded();
  expect(await page.locator("main").innerText()).not.toContain("PRIVATE-SOURCE");
  const operation = new URL(page.url()).pathname.split("/").at(-1)!;
  const receipt = await (await request.get(`/api/v1/conversations/${operation}`,{ headers: headers(alice.token) })).json();
  const client = new Client({ host: process.env.APP_ORIGIN!,auth: { bearer: alice.token } });
  let requestId: string | undefined;
  for await (const event of client.sessions.attach(receipt.sessionId).stream({ follow: false })) {
    if (event.type === "input.requested") requestId = event.data.requests[0].requestId;
  }
  expect(requestId).toBeTruthy();
  const foreign = await request.post(`/eve/v1/session/${receipt.sessionId}`,{ headers: headers(bob.token),data: { inputResponses: [{ requestId,optionId: "approve" }] } });
  expect(foreign.status()).toBe(401);
  expect((await (await request.get(`/api/v1/uploads/${reference.id}`,{ headers: headers(alice.token) })).json()).scan.checkedAt).toBe(before.scan.checkedAt);
  await page.reload();await expect(page.getByLabel("Referenced file")).toHaveText(`${name} · Review 1`);
  await expect(page.getByRole("button",{ name: "Approve",exact: true })).toBeEnabled({ timeout: 30_000 });
  // Resumed controls fade from disabled opacity. Audit their settled enabled state.
  await expect.poll(() => page.getByRole("button",{ name: "Approve",exact: true }).evaluate(button => getComputedStyle(button).opacity)).toBe("1");
  await auditAccessibility(page,"native file approval after reload");
  await page.getByRole("button",{ name: "Approve",exact: true }).click();
  await expect(page.getByText(/Reviewed source:/)).toHaveCount(1,{ timeout: 30_000 });await settle(page,request,alice.token,2);
  const source = await page.getByText(/Reviewed source:/).innerText();
  const result = JSON.parse(source.slice(source.indexOf("Reviewed source: ")+"Reviewed source: ".length));
  expect(result).toEqual({ id: reference.id,sha256: reference.sha256,reviewRevision: 1,mediaType: "text/plain",text,trust: "untrusted-user-content" });
  await expect(page.locator('[aria-label="Referenced file"] b')).toHaveCount(0);
  const listed = await (await request.get("/api/v1/conversations",{ headers: headers(alice.token) })).json();
  expect(listed.items[0].title).toBe("Read this file and preserve its text.");
  await choose(page,reference.id);await send(page,"Read the file again.");
  await expect(page.getByRole("button",{ name: "Cancel",exact: true })).toBeEnabled({ timeout: 30_000 });await page.getByRole("button",{ name: "Cancel",exact: true }).click();
  await settle(page,request,alice.token,4);expect(await page.getByText(/Reviewed source:/).last().innerText()).not.toContain("PRIVATE-SOURCE");
  await page.reload();await expect(page.getByLabel("Referenced file")).toHaveCount(2);await auditAccessibility(page,"replayed reviewed references");
});

test("revocation blocks a selected draft and a parked approval without releasing source text",async ({ page,request }) => {
  const alice = await user(request),reference = await upload(request,alice.token);await login(page,alice.email);await choose(page,reference.id);
  const revoked = await request.put(`/api/v1/uploads/${reference.id}/review`,{ headers: headers(alice.token),data: { sha256: reference.sha256,revision: 1,approved: false } });expect(revoked.status()).toBe(200);
  await send(page,"Read the selected file.");await expect(page.getByRole("main").getByRole("alert")).toContainText("file review changed");
  await expect(page.getByPlaceholder("Send a message…")).toHaveValue("Read the selected file.");expect(new URL(page.url()).pathname).toBe("/s");
  expect((await (await request.get("/api/v1/conversations",{ headers: headers(alice.token) })).json()).items).toHaveLength(0);
  const approved = await request.put(`/api/v1/uploads/${reference.id}/review`,{ headers: headers(alice.token),data: { sha256: reference.sha256,revision: 2,approved: true } });expect(approved.status()).toBe(200);
  await page.getByRole("button",{ name: "Remove file reference" }).click();await choose(page,reference.id);await send(page,"Read the selected file.");
  await expect(page.getByRole("button",{ name: "Approve",exact: true })).toBeEnabled({ timeout: 30_000 });
  expect((await request.put(`/api/v1/uploads/${reference.id}/review`,{ headers: headers(alice.token),data: { sha256: reference.sha256,revision: 3,approved: false } })).status()).toBe(200);
  await page.getByRole("button",{ name: "Approve",exact: true }).click();await settle(page,request,alice.token,2);
  expect(await page.locator("main").innerText()).not.toContain("PRIVATE-SOURCE");
  await expect(page.getByText(/Reviewed source:/)).toContainText(/unavailable|Private upload reading failed/);
});

test("another real account cannot list, review, extract or read a supplied private reference",async ({ page,request }) => {
  const alice = await user(request),bob = await user(request),reference = await upload(request,alice.token);
  for (const suffix of ["","/review","/text"]) expect((await request.get(`/api/v1/uploads/${reference.id}${suffix}`,{ headers: headers(bob.token) })).status()).toBe(404);
  await login(page,bob.email);await page.getByRole("button",{ name: "Choose reviewed file" }).click();
  await expect(page.getByText(/No eligible text files/)).toBeVisible();expect(await page.locator("main").innerText()).not.toContain(name);
  await send(page,encodeReviewedUploadMessage("Read this supplied file reference.",reference));await settle(page,request,bob.token,1);
  await expect(page.getByRole("button",{ name: "Approve",exact: true })).toHaveCount(0);
  expect(await page.locator("main").innerText()).not.toContain("PRIVATE-SOURCE");
  await expect(page.getByText(/Reviewed source:/)).toContainText("unavailable");
});
