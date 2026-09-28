import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { auditAccessibility } from "../helpers/accessibility";
import { run as runCli } from "../../scripts/app-cli";
import { preferences,defaultPreferences } from "../../lib/preferences/contract";
import { runHostedSmoke } from "../../scripts/smoke-hosted.mjs";
import { createSessionAccessStore } from "../../lib/agent-access/store";
import { createBudgetStore } from "../../lib/budgets/store";
import { createClient } from "@supabase/supabase-js";
import type { ProjectionEntry } from "../../lib/agent-access/projection-contract";
import { uploadObjectKey } from "../../lib/uploads/contract";
import { SUPABASE_UPLOAD_BUCKET } from "../../lib/uploads/supabase";

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

// This suite is explicitly selected by --supabase; other modes keep their own
// SQLite contracts. No hosted account or optional credential enables this case.
if (process.env.DATA_PROVIDER === "supabase") test("real Auth user tokens cannot read tables or invoke backend RPCs directly",async ({ request }) => {
  const alice = `sql-alice-${randomUUID()}@example.test`,bob = `sql-bob-${randomUUID()}@example.test`;
  await confirmedUser(request,alice);await confirmedUser(request,bob);
  const token = await tokenFor(request,alice),other = await tokenFor(request,bob);
  const profile = await (await request.get("/api/v1/account/profile",{ headers: { authorization: `Bearer ${token}` } })).json();
  const created = await request.post("/api/v1/records",{ headers: { authorization: `Bearer ${token}` },data: { title: "Actual Supabase row",content: "Only the current account" } });
  expect(created.status()).toBe(201);const row = await created.json();
  const url = process.env.SUPABASE_URL!,secret = process.env.SUPABASE_SECRET_KEY!;
  if (!url || !secret) throw new Error("The Supabase fixture must provide its disposable backend connection.");
  const admin = createClient(url,secret,{ auth: { persistSession: false,autoRefreshToken: false } });
  const stored = await admin.from("app_records").select("id,title,tenant,subject").eq("id",row.id).single();
  expect(stored.error).toBeNull();expect(stored.data).toEqual({ id: row.id,title: row.title,tenant: `supabase:${auth}`,subject: profile.id });
  for (const bearer of [process.env.SUPABASE_PUBLISHABLE_KEY!,token,other]) {
    const client = createClient(url,process.env.SUPABASE_PUBLISHABLE_KEY!,{ auth: { persistSession: false,autoRefreshToken: false },global: { headers: { authorization: `Bearer ${bearer}` } } });
    for (const table of ["app_records","app_record_creates","app_conversations","app_conversation_events","app_conversation_runs",
      "app_artifacts","app_artifact_versions","app_budget_accounts","app_budget_reservations","app_budget_attempts","app_budget_corrections",
      "app_uploads","app_upload_scans","app_upload_reviews","app_user_preferences","app_request_limits","app_internal_nonces"]) {
      expect((await client.from(table).select("*").limit(1)).error?.code,table).toBe("42501");
    }
    expect((await client.from("app_records").insert({ id: randomUUID(),tenant: `supabase:${auth}`,subject: profile.id,title: "Forged",content: "Forbidden" })).error?.code).toBe("42501");
    const input = { tenant: `supabase:${auth}`,subject: profile.id,now: Date.now() };
    expect((await client.rpc("app_budget_command",{ command: "snapshot",input })).error?.code).toBe("42501");
    expect((await client.rpc("app_preferences_command",{ command: "update",input: { ...input,patch: { revision: 0,theme: "dark" } } })).error?.code).toBe("42501");
    expect((await client.rpc("app_request_limit",{ input: { ...input,limit: 100 } })).error?.code).toBe("42501");
    expect((await client.rpc("app_upload_review_command",{ command: "getReview",input: { ...input,id: randomUUID() } })).error?.code).toBe("42501");
  }
  expect((await request.get(`/api/v1/records/${row.id}`,{ headers: { authorization: `Bearer ${token}` } })).status()).toBe(200);
  expect((await request.get(`/api/v1/records/${row.id}`,{ headers: { authorization: `Bearer ${other}` } })).status()).toBe(404);
});

test("portable account-browser smoke verifies login, records, reload and logout with chat disabled",async ({ request }) => {
  const alice = `smoke-alice-${randomUUID()}@example.test`,bob = `smoke-bob-${randomUUID()}@example.test`;
  await confirmedUser(request,alice);await confirmedUser(request,bob);
  const result = await runHostedSmoke({ url: process.env.APP_ORIGIN!,token: await tokenFor(request,alice),otherToken: await tokenFor(request,bob),accountBrowser: true,uploads: true,contract: true,
    browserAccounts: { primary: { email: alice,password },other: { email: bob,password } } });
  expect(result.accountBrowser).toBe(true);expect(result.agent).toBeUndefined();expect(result.uploadId).toMatch(/^[0-9a-f-]{36}$/i);
});

test("paused chat retains private history, artifacts, usage and application export across browser, REST, CLI and MCP",async ({ page,request }) => {
  expect(process.env.AI_CHAT_ENABLED).toBe("false");
  const alice = `retained-alice-${randomUUID()}@example.test`,bob = `retained-bob-${randomUUID()}@example.test`;
  await confirmedUser(request,alice);await confirmedUser(request,bob);
  const token = await tokenFor(request,alice),other = await tokenFor(request,bob);
  const headers = { authorization: `Bearer ${token}` },foreign = { authorization: `Bearer ${other}` };
  const profile = await (await request.get("/api/v1/account/profile",{ headers })).json();
  const owner = { tenant: `supabase:${process.env.SUPABASE_AUTH_URL}`,subject: profile.id },operation = randomUUID(),session = `stored-${randomUUID()}`;
  const store = await createSessionAccessStore();
  let artifactId = "";
  // Seed retained application data only: this is not an executed model turn.
  try {
    expect(await store.reserve({ ...owner,id: randomUUID(),operationId: operation,requestHash: "a".repeat(64) },"Retained private conversation")).toBe(true);
    expect(await store.bind(owner,operation,session)).toBe(true);
    const payloads: ProjectionEntry["payload"][] = [
      { kind: "message",role: "assistant",parts: [{ type: "text",text: "Stored assistant fixture" }] },
      { kind: "run",state: "running" },{ kind: "run",state: "completed" },
    ];
    for (const [sequence,payload] of payloads.entries()) {
      expect(await store.appendProjection(owner,operation,session,{ schemaVersion: 1,eventId: `evt_${String(sequence).padStart(26,"0")}`,
        at: "2026-09-27T10:00:00.000Z",turnId: "retained-fixture-turn",sequence,payload },sequence)).toBe("inserted");
    }
    const saved = await store.saveArtifact(owner,operation,session,"retained-artifact-call",{ title: "Retained private artifact",content: "Approved stored fixture text" });
    if (saved.status !== "created") throw new Error("Retained fixture could not be saved");
    artifactId = saved.artifact.id;
  } finally { await store.close(); }
  const otherProfile = await (await request.get("/api/v1/account/profile",{ headers: foreign })).json();
  const budget = await createBudgetStore();
  const correction = randomUUID(),pending = randomUUID();
  try {
    const policy = { id: "retained-fixture",dailyMicros: 100,maxActive: 10,maxPerMinute: 20 };
    for (const [subject,operationId] of [[owner.subject,operation],[owner.subject,pending],[otherProfile.id,randomUUID()]]) {
      expect(await budget.reserve({ ...owner,subject,operationId,requestHash: "b".repeat(64),estimateMicros: 20,policy,now: Date.now() })).toMatchObject({ status: "reserved" });
      if (subject === otherProfile.id) await budget.settle({ ...owner,subject,operationId,actualMicros: 73 });
    }
    expect(await budget.settle({ ...owner,operationId: operation,actualMicros: null })).toBe(true);
    expect(await budget.correctSettlement({ ...owner,operationId: operation,correctionId: correction,expectedActualMicros: null,correctedActualMicros: 5,
      actor: "private-export-operator",reason: "Private fixture evidence for retained usage",evidenceRef: "private-export-receipt" })).toBe("applied");
  } finally { await budget.close(); }
  const currentUsage = await (await request.get("/api/v1/usage",{ headers })).json();
  const retainedUsage = { dailyLimitMicros: null,chargedMicros: 5,reservedMicros: 20,active: 1 };
  expect(currentUsage).toMatchObject(retainedUsage);
  expect(await runCli(["usage"],{ APP_API_URL: process.env.APP_ORIGIN,APP_API_TOKEN: token })).toMatchObject(retainedUsage);
  expect(await (await request.get("/api/v1/usage",{ headers: foreign })).json()).toMatchObject({ dailyLimitMicros: null,chargedMicros: 73,reservedMicros: 0 });
  for (const url of ["/api/v1/usage","/api/v1/usage/reservations","/api/v1/usage/corrections"]) expect((await request.get(url)).status()).toBe(401);
  const urls = [`/api/v1/conversations/${operation}/metadata`,`/api/v1/conversations/${operation}/events`,`/api/v1/conversations/${operation}/runs`,
    `/api/v1/artifacts/${artifactId}`,`/api/v1/artifacts/${artifactId}/versions`,`/api/v1/artifacts/${artifactId}/download`];
  for (const url of urls) {
    expect((await request.get(url,{ headers })).status()).toBe(200);
    expect((await request.get(url,{ headers: foreign })).status()).toBe(404);
    expect((await request.get(url)).status()).toBe(401);
  }
  expect(await runCli(["conversations","get",operation],{ APP_API_URL: process.env.APP_ORIGIN,APP_API_TOKEN: token })).toMatchObject({ title: "Retained private conversation" });
  expect(await runCli(["artifacts","get",artifactId],{ APP_API_URL: process.env.APP_ORIGIN,APP_API_TOKEN: token })).toMatchObject({ content: "Approved stored fixture text" });
  const client = new Client({ name: "paused-history",version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${process.env.APP_ORIGIN}/api/mcp`),{ requestInit: { headers } }));
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    expect(tools).toContain("conversations_get");expect(tools).toContain("artifacts_versions");
    expect(tools).not.toContain("conversations_source_events");expect(tools).not.toContain("conversations_reconcile");expect(tools).toContain("usage_get");
    expect(tools).toContain("account_request_limit");
    const usage = await client.callTool({ name: "usage_get",arguments: {} });expect(usage.isError).not.toBe(true);
    expect(JSON.parse((usage.content as { text: string }[])[0].text)).toMatchObject(retainedUsage);
    const corrections = await client.callTool({ name: "usage_corrections",arguments: {} });expect(corrections.isError).not.toBe(true);
    expect(JSON.parse((corrections.content as { text: string }[])[0].text)).toMatchObject({ items: [{ correctionId: correction,correctedActualMicros: 5 }] });
    for (const uri of [`conversations:///${operation}`,`artifacts:///${artifactId}`]) expect((await client.readResource({ uri })).contents).toHaveLength(1);
    const edited = await client.callTool({ name: "artifacts_update",arguments: { id: artifactId,revision: 1,title: "Retained edited artifact",content: "Owner edit with chat paused" } });
    expect(edited.isError).not.toBe(true);
  } finally { await client.close(); }
  expect((await request.patch(`/api/v1/conversations/${operation}`,{ headers,data: { revision: 1,title: "Retained renamed conversation" } })).status()).toBe(200);
  expect((await request.patch(`/api/v1/artifacts/${artifactId}`,{ headers: foreign,data: { revision: 2,title: "Stolen",content: "Stolen" } })).status()).toBe(404);
  const record = await request.post("/api/v1/records",{ headers,data: { title: "Paused export record",content: "Owned retained record" } });expect(record.status()).toBe(201);
  const uploaded = await request.post("/api/v1/uploads",{ headers: { ...headers,"content-type": "application/octet-stream",
    "x-upload-name": "paused-export.txt","x-upload-media-type": "text/plain" },data: Buffer.from("Private bytes excluded") });expect(uploaded.status()).toBe(201);
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-paused-export-"));
  try {
    const output = join(directory,"account.ndjson");
    const exported = await runCli(["export","application",output],{ APP_API_URL: process.env.APP_ORIGIN,APP_API_TOKEN: token });
    expect(exported).toMatchObject({ counts: { profile: 1,preferences: 1,requestLimit: 1,records: 1,conversations: 1,projections: 3,runs: 1,
      artifacts: 1,artifactVersions: 2,uploads: 1,uploadReviews: 1,reservations: 2,corrections: 1,usage: 1 } });
    const raw = await readFile(output,"utf8"),lines = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0].value.format).toBe("ai-app-jumpstart-visible-data-v11");
    expect(lines.find(line => line.type === "request_limit").value).toMatchObject({ admitted: expect.any(Number),windowStartAt: expect.any(String) });
    expect(lines.find(line => line.type === "usage").value).toMatchObject(retainedUsage);
    expect(lines.find(line => line.type === "budget_correction").value).toMatchObject({ correctionId: correction,correctedActualMicros: 5 });
    expect(raw).not.toMatch(/private-export-operator|private-export-receipt|Private fixture evidence|Private bytes excluded/);
    expect(await runCli(["export","verify",output],{})).toMatchObject({ format: "ai-app-jumpstart-visible-data-v11",counts: { requestLimit: 1,reservations: 2,corrections: 1 } });
    const foreignOutput = join(directory,"other.ndjson");
    expect(await runCli(["export","application",foreignOutput],{ APP_API_URL: process.env.APP_ORIGIN,APP_API_TOKEN: other })).toMatchObject({ counts: { records: 0,conversations: 0,artifacts: 0,uploads: 0,reservations: 1,corrections: 0 } });
    expect(await readFile(foreignOutput,"utf8")).not.toContain(artifactId);
  } finally { await rm(directory,{ recursive: true,force: true }); }
  expect((await request.post("/api/v1/conversations",{ headers,data: { operationId: randomUUID(),prompt: "Do not dispatch" } })).status()).toBe(503);
  expect((await request.get(`/api/v1/conversations/${operation}`,{ headers })).status()).toBe(503);
  expect((await request.post(`/api/v1/conversations/${operation}/reconcile`,{ headers,data: { resume: true } })).status()).toBe(503);
  const runtimeRequests: string[] = [];
  page.on("request",request => { const path = new URL(request.url()).pathname;if (path.startsWith("/eve/")) runtimeRequests.push(path); });
  await login(page,alice);
  const navigation = page.getByRole("navigation",{ name: "Workspace" });
  await expect(navigation.getByRole("link",{ name: "Conversations",exact: true })).toBeVisible();
  await expect(navigation.getByRole("link",{ name: "Artifacts",exact: true })).toBeVisible();
  await expect(navigation.getByRole("link",{ name: "AI usage",exact: true })).toBeVisible();
  await expect(navigation.getByRole("link",{ name: "Chat",exact: true })).toHaveCount(0);
  await navigation.getByRole("link",{ name: "AI usage",exact: true }).click();
  await expect(page.getByText(/Chat is disabled\. There is no active spending allowance/)).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);await expect(page.getByText("$0.000005",{ exact: true })).toBeVisible();
  await page.reload();await expect(page.getByText("$0.000005",{ exact: true })).toBeVisible();
  await auditAccessibility(page,"paused-chat usage");
  await page.goto("/conversations");
  const title = page.getByRole("link",{ name: "Retained renamed conversation",exact: true });
  await expect(title).toHaveAttribute("href",`/conversations/${operation}/activity`);await title.click();
  await expect(page.getByText("Stored assistant fixture",{ exact: true })).toBeVisible();
  await page.reload();await expect(page.getByText("Stored assistant fixture",{ exact: true })).toBeVisible();
  await page.getByRole("link",{ name: "Run history",exact: true }).click();
  await expect(page.getByRole("heading",{ name: "Awaiting verification",exact: true })).toBeVisible();
  await expect(page.getByRole("button",{ name: "Check history",exact: true })).toHaveCount(0);
  await auditAccessibility(page,"paused-chat run history");
  await page.goto("/artifacts");await expect(page.getByRole("heading",{ name: "Retained edited artifact" })).toBeVisible();
  await expect(page.getByRole("link",{ name: "Source conversation" })).toHaveAttribute("href",`/conversations/${operation}/activity`);
  await page.reload();await expect(page.getByRole("heading",{ name: "Retained edited artifact" })).toBeVisible();
  await auditAccessibility(page,"paused-chat artifacts");expect(runtimeRequests).toEqual([]);
  await page.goto("/account");await page.getByRole("button",{ name: "Sign out",exact: true }).click();await atPath(page,"/login");
  await login(page,bob);await page.goto("/artifacts");await expect(page.getByText("No artifacts yet.")).toBeVisible();
  await page.goto(`/conversations/${operation}/activity`);await expect(page.getByRole("main").getByRole("alert")).toContainText("Conversation not found");
  expect((await request.delete(`/api/v1/artifacts/${artifactId}`,{ headers })).status()).toBe(204);
  expect((await request.get(`/api/v1/artifacts/${artifactId}/versions`,{ headers })).status()).toBe(404);
});

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

test("signed-in uploads remain private across account changes and can be deleted", async ({ page, request }) => {
  const alice = `upload-alice-${randomUUID()}@example.test`;
  const bob = `upload-bob-${randomUUID()}@example.test`;
  const filename = `account-${randomUUID()}.txt`;
  await confirmedUser(request, alice);
  await confirmedUser(request, bob);

  await page.goto("/uploads");
  await atPath(page, "/login");
  await page.getByLabel("Email", { exact: true }).fill(alice);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await atPath(page, "/uploads");
  await expect(page.getByRole("heading", { name: "Private uploads" })).toBeVisible();
  await auditAccessibility(page, "signed-in uploads");
  await page.locator('input[type="file"]').setInputFiles({ name: filename, mimeType: "text/plain", buffer: Buffer.from("Alice private bytes") });
  const accepted = page.waitForResponse(response => response.url().endsWith("/api/v1/uploads") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Upload to quarantine" }).click();
  const uploadResponse = await accepted;
  expect(uploadResponse.status()).toBe(201);
  const uploaded = await uploadResponse.json();
  await expect(page.getByRole("listitem").filter({ hasText: filename })).toContainText("Quarantined · unavailable for download or agent use");
  await auditAccessibility(page, "signed-in quarantined upload");

  const bobToken = await tokenFor(request, bob);
  const aliceToken = await tokenFor(request, alice);
  let storage: ReturnType<typeof createClient>["storage"] | undefined,key: string | undefined;
  if (process.env.UPLOAD_STORAGE_PROVIDER === "supabase") {
    const profile = await (await request.get("/api/v1/account/profile",{ headers: { authorization: `Bearer ${aliceToken}` } })).json();
    key = uploadObjectKey({ tenant: `supabase:${auth}`,subject: profile.id },uploaded.id);
    storage = createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_SECRET_KEY!,{ auth: { persistSession: false,autoRefreshToken: false } }).storage;
    const stored = await storage.from(SUPABASE_UPLOAD_BUCKET).download(key);
    expect(stored.error).toBeNull();expect(await stored.data!.text()).toBe("Alice private bytes");
    // Neither the uploader nor another verified user gets direct Storage access.
    // The fixture has a broad permissive policy; the restrictive app policy wins.
    for (const bearer of [process.env.SUPABASE_PUBLISHABLE_KEY!,aliceToken,bobToken]) {
      const direct = createClient(process.env.SUPABASE_URL!,process.env.SUPABASE_PUBLISHABLE_KEY!,{
        auth: { persistSession: false,autoRefreshToken: false },global: { headers: { authorization: `Bearer ${bearer}` } },
      }).storage.from(SUPABASE_UPLOAD_BUCKET);
      expect((await direct.download(key)).error).not.toBeNull();
      expect((await direct.createSignedUrl(key,60)).error).not.toBeNull();
      expect((await direct.upload(key,new Blob(["forged"]),{ upsert: true,contentType: "application/octet-stream" })).error).not.toBeNull();
      expect((await direct.upload(`${key}-forged`,new Blob(["forged"]),{ contentType: "application/octet-stream" })).error).not.toBeNull();
      await direct.remove([key]);
      const listing = await direct.list(key.split("/").slice(0,-1).join("/"));
      expect(listing.data?.some(item => item.name === uploaded.id)).not.toBe(true);
      expect((await fetch(direct.getPublicUrl(key).data.publicUrl)).ok).toBe(false);
    }
    const unchanged = await storage.from(SUPABASE_UPLOAD_BUCKET).download(key);
    expect(unchanged.error).toBeNull();expect(await unchanged.data!.text()).toBe("Alice private bytes");
  }
  const bobHeaders = { authorization: `Bearer ${bobToken}` };
  expect((await request.get(`/api/v1/uploads/${uploaded.id}`, { headers: bobHeaders })).status()).toBe(404);
  expect((await request.delete(`/api/v1/uploads/${uploaded.id}`, { headers: bobHeaders })).status()).toBe(404);
  const bobList = await request.get("/api/v1/uploads", { headers: bobHeaders });
  expect(bobList.status()).toBe(200);
  expect((await bobList.json()).items).toEqual([]);
  const bobMcp = new Client({ name: "upload-auth-isolation", version: "1" });
  try {
    await bobMcp.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", process.env.APP_ORIGIN!), { requestInit: { headers: bobHeaders } }));
    expect((await bobMcp.callTool({ name: "uploads_get", arguments: { id: uploaded.id } })).isError).toBe(true);
    expect(JSON.stringify((await bobMcp.callTool({ name: "uploads_list", arguments: {} })).content)).not.toContain(uploaded.id);
  } finally { await bobMcp.close(); }

  await page.goto("/account");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await atPath(page, "/login");
  await login(page, bob);
  await page.goto("/uploads");
  await expect(page.getByText("No uploads yet.")).toBeVisible();
  await expect(page.getByText(filename)).toHaveCount(0);

  const aliceMcp = new Client({ name: "upload-auth-owner", version: "1" });
  try {
    await aliceMcp.connect(new StreamableHTTPClientTransport(new URL("/api/mcp", process.env.APP_ORIGIN!), { requestInit: { headers: { authorization: `Bearer ${aliceToken}` } } }));
    const found = await aliceMcp.callTool({ name: "uploads_get", arguments: { id: uploaded.id } });
    expect(found.isError).not.toBe(true);
    expect(JSON.stringify(found.content)).toContain(uploaded.id);
    expect(JSON.stringify(found.content)).not.toContain("Alice private bytes");
  } finally { await aliceMcp.close(); }
  expect((await request.delete(`/api/v1/uploads/${uploaded.id}`, { headers: { authorization: `Bearer ${aliceToken}` } })).status()).toBe(204);
  expect((await request.get(`/api/v1/uploads/${uploaded.id}`, { headers: { authorization: `Bearer ${aliceToken}` } })).status()).toBe(404);
  if (storage && key) {
    expect((await storage.from(SUPABASE_UPLOAD_BUCKET).download(key)).error).not.toBeNull();
    const listing = await storage.from(SUPABASE_UPLOAD_BUCKET).list(key.split("/").slice(0,-1).join("/"));
    expect(listing.error).toBeNull();expect(listing.data?.some(item => item.name === uploaded.id)).toBe(false);
  }
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

test("account entry and authenticated workspace pass automated accessibility rules", async ({ page, request }) => {
  for (const [path, heading] of [["/login", "Sign in"], ["/signup", "Create account"], ["/recover", "Reset password"]]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading })).toBeVisible();
    await auditAccessibility(page, path);
  }

  const email = `accessible-${randomUUID()}@example.test`;
  await confirmedUser(request, email);
  await login(page, email);
  await auditAccessibility(page, "signed-in account");
  await page.goto("/account/password");
  await expect(page.getByRole("heading", { name: "Update password" })).toBeVisible();
  await auditAccessibility(page, "password update");
});

test("preferences hydrate without writes, sync across devices and restore device settings after logout",async ({ page,browser,request }) => {
  const alice = `preferences-alice-${randomUUID()}@example.test`,bob = `preferences-bob-${randomUUID()}@example.test`;
  await confirmedUser(request,alice);await confirmedUser(request,bob);
  const token = await tokenFor(request,alice),headers = { authorization: `Bearer ${token}` };
  const initial = await request.patch("/api/v1/account/preferences",{ headers,data: { revision: 0,theme: "dark",soundVolume: 0.25 } });
  expect(initial.status()).toBe(200);
  await page.addInitScript(() => {
    Reflect.set(window,"__soundContexts",0);
    const Original = window.AudioContext;
    if (Original) window.AudioContext = new Proxy(Original,{ construct(target,args) {
      Reflect.set(window,"__soundContexts",Reflect.get(window,"__soundContexts")+1);return Reflect.construct(target,args);
    } });
  });
  await page.goto("/records");
  const theme = page.locator('select[aria-label="Theme"]:visible');
  await expect(theme).toBeEnabled();await theme.selectOption("light");
  const writes: string[] = [];
  page.on("request",req => { if (new URL(req.url()).pathname === "/api/v1/account/preferences" && req.method() === "PATCH") writes.push(req.method()); });
  await login(page,alice);
  await expect(theme).toHaveValue("dark");expect(writes).toHaveLength(0);
  await expect(page.getByLabel("Enable sounds")).not.toBeChecked();
  await theme.selectOption("light");await expect(theme).toBeEnabled();
  await page.getByLabel("Enable sounds").click();await expect(page.getByLabel("Enable sounds")).toBeChecked();await expect(page.getByLabel("Enable sounds")).toBeEnabled();
  await page.getByLabel("Sound volume").press("End");
  for (let step = 0;step < 5;step++) await page.getByLabel("Sound volume").press("ArrowLeft");
  expect(writes).toHaveLength(2);
  await page.getByRole("button",{ name: "Save volume" }).click();
  await expect(page.getByRole("button",{ name: "Test sound" })).toBeEnabled();
  await page.reload();
  await expect(page.getByLabel("Enable sounds")).toBeChecked();
  await expect(page.getByLabel("Sound volume")).toHaveValue("0.75");
  expect(await page.evaluate(() => Reflect.get(window,"__soundContexts"))).toBe(0);
  await page.getByRole("button",{ name: "Load records",exact: true }).click();
  await page.getByLabel("Title",{ exact: true }).fill("Confirmed sound note");
  await page.getByRole("button",{ name: "Create record",exact: true }).click();
  await expect(page.getByRole("heading",{ name: "Confirmed sound note",exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Reflect.get(window,"__soundContexts"))).toBe(1);
  const saved = preferences.parse(await (await request.get("/api/v1/account/preferences",{ headers })).json());
  expect(saved).toMatchObject({ revision: 4,theme: "light",soundEnabled: true,soundVolume: 0.75 });
  expect(await runCli(["account","preferences"],{ APP_API_URL: process.env.APP_ORIGIN!,APP_API_TOKEN: token })).toEqual(saved);
  const client = new Client({ name: "preference-parity",version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp",process.env.APP_ORIGIN!),{ requestInit: { headers } }));
    const result = await client.callTool({ name: "account_preferences",arguments: {} });expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(saved);
  } finally { await client.close(); }
  await auditAccessibility(page,"saved account preferences");
  const second = await browser.newContext();
  try {
    const otherPage = await second.newPage();await login(otherPage,alice);
    const otherTheme = otherPage.locator('select[aria-label="Theme"]:visible');
    await expect(otherTheme).toHaveValue("light");await expect(otherPage.getByLabel("Enable sounds")).toBeChecked();
    await expect(otherPage.getByLabel("Sound volume")).toHaveValue("0.75");
    await otherTheme.selectOption("dark");await expect(otherTheme).toBeEnabled();
    await page.getByRole("button",{ name: "Refresh preferences" }).click();await expect(theme).toHaveValue("dark");
    await otherPage.getByRole("button",{ name: "Sign out",exact: true }).click();await atPath(otherPage,"/login");
    await login(otherPage,bob);
    await expect(otherTheme).toHaveValue("system");await expect(otherPage.getByLabel("Enable sounds")).not.toBeChecked();
    const bobToken = await tokenFor(request,bob);
    expect(await (await request.get("/api/v1/account/preferences",{ headers: { authorization: `Bearer ${bobToken}` } })).json()).toEqual(defaultPreferences);
  } finally { await second.close(); }
  await page.getByRole("button",{ name: "Sign out",exact: true }).click();await atPath(page,"/login");
  await page.goto("/records");await expect(theme).toHaveValue("light");
  expect((await request.patch("/api/v1/account/preferences",{ headers,data: { revision: 4,theme: "system" } })).status()).toBe(409);
});
