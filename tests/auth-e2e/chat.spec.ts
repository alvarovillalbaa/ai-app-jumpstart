import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { run as runCli } from "../../scripts/app-cli";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { creationBody, requestHash } from "../../lib/agent-access/signing";
import { sourceEventPage } from "../../lib/agent-access/source-events";
import { projectionPage } from "../../lib/agent-access/projection-contract";
import { auditAccessibility } from "../helpers/accessibility";
import { runHostedSmoke } from "../../scripts/smoke-hosted.mjs";

const auth = process.env.TEST_AUTH_ORIGIN!;
const password = "Fixture-only-password-42!";
async function user(request: APIRequestContext) {
  const email = `chat-${randomUUID()}@example.test`;
  const created = await request.post(`${auth}/auth/v1/admin/users`, { headers: {
    authorization: `Bearer ${process.env.TEST_AUTH_ADMIN_KEY!}`, apikey: process.env.SUPABASE_PUBLISHABLE_KEY!,
  }, data: { email, password, email_confirm: true } });
  expect(created.status()).toBe(200);
  const account = await created.json();
  const response = await request.post(`${auth}/auth/v1/token?grant_type=password`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY! }, data: { email, password } });
  expect(response.status()).toBe(200);
  return { id: account.id as string,email, token: (await response.json()).access_token as string };
}
async function login(page: Page, email: string) {
  await page.goto("/login?next=/s");
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/s");
}
async function send(page: Page, message: string) {
  const input = page.getByPlaceholder("Send a message…");
  await expect(input).toBeEnabled(); await input.fill(message); await input.press("Enter");
}
async function expectSettledTurn(page: Page, request: APIRequestContext, token: string, count: number) {
  await expect(page.getByRole("button", { name: "Stop" })).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => {
    const response = await request.get("/api/v1/usage", { headers: { authorization: `Bearer ${token}` } });
    expect(response.status()).toBe(200);
    return response.json();
  }, { timeout: 30_000 }).toMatchObject({ chargedMicros: count * 20, reservedMicros: 0, active: 0, unknownCosts: count });
}
async function receiptGate(open: boolean) {
  if (process.env.TEST_CHAT_CONTAINER) {
    execFileSync("docker", ["exec", process.env.TEST_CHAT_CONTAINER, "sh", "-c", open ? "printf ready > /app/.data/gate" : "rm -f /app/.data/gate"]);
  } else if (open) await writeFile(process.env.TEST_RECEIPT_GATE_HOST!, "ready");
  else await rm(process.env.TEST_RECEIPT_GATE_HOST!, { force: true });
}
async function runtimeReceipts(kind: "models" | "failures") {
  const output = process.env.TEST_CHAT_CONTAINER
    ? execFileSync("docker", ["exec", process.env.TEST_CHAT_CONTAINER, "sh", "-c", `cat /app/.data/${kind}.txt 2>/dev/null || true`], { encoding: "utf8" })
    : await readFile(process.env[kind === "models" ? "TEST_MODEL_RECEIPTS_HOST" : "TEST_FAILURE_RECEIPTS_HOST"]!, "utf8").catch(() => "");
  return output.trim().split("\n").filter(Boolean);
}
function seedBudgetOnly(subject: string, operationId: string, message: string) {
  const hash = requestHash(creationBody({ message,operationId }).body);
  const script = `import { DatabaseSync } from "node:sqlite";
    const [path,tenant,subject,operationId,hash] = process.argv.slice(1);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
    const now = Date.now();
    db.prepare("INSERT INTO app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status) VALUES (?,?,?,?,?,?,?,?,'reserved')")
      .run(operationId,tenant,subject,hash,"fixture",20,Math.floor(now/86400000),now);
    db.close();`;
  const container = process.env.TEST_CHAT_CONTAINER;
  const args = ["--input-type=module","-e",script,container ? "/app/.data/records.sqlite" : process.env.SQLITE_PATH!,`supabase:${auth}`,subject,operationId,hash];
  if (container) execFileSync("docker",["exec",container,"node",...args]);
  else execFileSync(process.execPath,args);
}
function seedBudgetCorrection(subject: string) {
  const operationId = randomUUID(),correctionId = randomUUID();
  const script = `import { DatabaseSync } from "node:sqlite";
    const [path,tenant,subject,operationId,correctionId] = process.argv.slice(1);
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      db.prepare("INSERT INTO app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status,actual_micros) VALUES (?,?,?,?,?,?,?,?,'settled',20)")
        .run(operationId,tenant,subject,"a".repeat(64),"fixture",20,Math.floor(now/86400000),now);
      db.prepare("INSERT INTO app_budget_corrections(correction_id,operation_id,tenant,subject,previous_actual_micros,corrected_actual_micros,actor,reason,evidence_ref,at) VALUES (?,?,?,?,20,7,?,?,?,?)")
        .run(correctionId,operationId,tenant,subject,"private-operator","Private operator invoice analysis","private-evidence-reference",now);
      db.prepare("UPDATE app_budget_reservations SET actual_micros=7 WHERE operation_id=?").run(operationId);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    finally { db.close(); }`;
  const container = process.env.TEST_CHAT_CONTAINER;
  const args = ["--input-type=module","-e",script,container ? "/app/.data/records.sqlite" : process.env.SQLITE_PATH!,`supabase:${auth}`,subject,operationId,correctionId];
  if (container) execFileSync("docker",["exec",container,"node",...args]);
  else execFileSync(process.execPath,args);
  return { operationId,correctionId };
}

test("a stored cost correction is owner-scoped across API, CLI, MCP and export",async ({ request }) => {
  const alice = await user(request),bob = await user(request);
  expect((await request.get("/api/v1/usage",{ headers: { authorization: `Bearer ${alice.token}` } })).status()).toBe(200);
  const { operationId,correctionId } = seedBudgetCorrection(alice.id);
  const env = { APP_API_URL: process.env.APP_ORIGIN!,APP_API_TOKEN: alice.token };
  const response = await request.get("/api/v1/usage/corrections?limit=1",{ headers: { authorization: `Bearer ${alice.token}` } });
  expect(response.status()).toBe(200);
  const page = await response.json();
  expect(page).toMatchObject({ items: [{ correctionId,operationId,previousActualMicros: 20,correctedActualMicros: 7 }],nextCursor: null });
  expect(JSON.stringify(page)).not.toMatch(/private-operator|Private operator|private-evidence/);
  expect(await runCli(["usage","corrections","--limit","1"],env)).toEqual(page);
  expect((await request.get("/api/v1/usage/corrections")).status()).toBe(401);
  const foreign = await request.get("/api/v1/usage/corrections",{ headers: { authorization: `Bearer ${bob.token}` } });
  expect(foreign.status()).toBe(200);
  expect(await foreign.json()).toEqual({ items: [],nextCursor: null });
  const client = new Client({ name: "correction-browser-contract",version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp",env.APP_API_URL),{ requestInit: { headers: { authorization: `Bearer ${alice.token}` } } }));
    const result = await client.callTool({ name: "usage_corrections",arguments: { limit: 1 } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(page);
  } finally { await client.close(); }
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-correction-export-"));
  try {
    const aliceFile = join(directory,"alice.ndjson"),bobFile = join(directory,"bob.ndjson");
    expect(await runCli(["export","application",aliceFile],env)).toMatchObject({ counts: { corrections: 1,reservations: 1 } });
    const aliceExport = await readFile(aliceFile,"utf8");
    expect(aliceExport).toContain(correctionId);
    expect(aliceExport).not.toMatch(/private-operator|Private operator|private-evidence/);
    expect(await runCli(["export","application",bobFile],{ ...env,APP_API_TOKEN: bob.token })).toMatchObject({ counts: { corrections: 0,reservations: 0 } });
    expect(await readFile(bobFile,"utf8")).not.toContain(correctionId);
  } finally { await rm(directory,{ recursive: true,force: true }); }
});

test("verified users create, replay and follow up; foreign users cannot resolve or stream; daily admission stops work", async ({ page, request }) => {
  const alice = await user(request), bob = await user(request);
  await login(page, alice.email);
  const recoveryRoute = /\/api\/v1\/conversations\/[^/]+\/reconcile$/;
  await page.route(recoveryRoute,route => route.abort("connectionreset"));
  await send(page, "Private deterministic conversation");
  await expect(page.getByText("Deterministic owned response", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  await auditAccessibility(page, "completed chat turn");
  const path = new URL(page.url()).pathname;
  expect(path).toMatch(/^\/s\/[a-f0-9-]{36}$/);
  const lookup = await request.get(`/api/v1/conversations/${path.split("/").at(-1)}`, { headers: { authorization: `Bearer ${alice.token}` } });
  expect(lookup.status()).toBe(200); const receipt = await lookup.json();
  expect(receipt.status).toBe("active");
  const projectionUrl = `/api/v1/conversations/${receipt.operationId}/events`;
  await expect.poll(async () => {
    const response = await request.get(projectionUrl,{ headers: { authorization: `Bearer ${alice.token}` } });
    const body = await response.json();
    return body.items?.some((entry: { payload: { kind: string;state?: string } }) => entry.payload.kind === "run" && entry.payload.state === "completed");
  }).toBe(true);
  const projections = projectionPage.parse(await (await request.get(projectionUrl,{ headers: { authorization: `Bearer ${alice.token}` } })).json());
  expect(projections).toMatchObject({ schemaVersion: 1,source: "eve-stream" });
  expect(JSON.stringify(projections)).toContain("Private deterministic conversation");
  expect(JSON.stringify(projections)).toContain("Deterministic owned response");
  expect(projections.items.every(item => item.sourceIndex === undefined)).toBe(true);
  expect((await request.get(projectionUrl,{ headers: { authorization: `Bearer ${bob.token}` } })).status()).toBe(404);
  await page.unroute(recoveryRoute);
  await page.reload();
  await expect.poll(async () => {
    const current = projectionPage.parse(await (await request.get(projectionUrl,{ headers: { authorization: `Bearer ${alice.token}` } })).json());
    return current.items.length > 0 && current.items.every(item => item.sourceIndex !== undefined);
  },{ timeout: 30_000 }).toBe(true);
  const recovery = await request.post(`/api/v1/conversations/${receipt.operationId}/reconcile`,{ headers: { authorization: `Bearer ${alice.token}` },data: { resume: true } });
  expect(recovery.status()).toBe(200); expect(await recovery.json()).toMatchObject({ processed: 0,inserted: 0,complete: true });
  const recovered = projectionPage.parse(await (await request.get(projectionUrl,{ headers: { authorization: `Bearer ${alice.token}` } })).json());
  expect(recovered.items.map(({ sourceIndex,...entry }) => { expect(sourceIndex).toBeGreaterThanOrEqual(0); return entry; })).toEqual(projections.items);
  const history = await request.get("/api/v1/conversations",{ headers: { authorization: `Bearer ${alice.token}` } });
  expect(history.status()).toBe(200);
  const summary = (await history.json()).items[0];
  expect(summary).toMatchObject({ title: "Private deterministic conversation",operationId: receipt.operationId,revision: 1 });
  expect(summary.sessionId).toBeUndefined(); expect(summary.requestHash).toBeUndefined();
  expect((await (await request.get("/api/v1/conversations",{ headers: { authorization: `Bearer ${bob.token}` } })).json()).items).toEqual([]);
  expect((await request.patch(`/api/v1/conversations/${receipt.operationId}`,{ headers: { authorization: `Bearer ${bob.token}` },data: { revision: 1,title: "Stolen" } })).status()).toBe(404);
  expect((await request.get(`/api/v1/conversations/${receipt.operationId}`, { headers: { authorization: `Bearer ${bob.token}` } })).status()).toBe(404);
  expect((await request.get(`/eve/v1/session/${receipt.sessionId}/stream`, { headers: { authorization: `Bearer ${bob.token}` } })).status()).toBe(401);
  expect((await request.post("/eve/v1/session", { headers: { authorization: `Bearer ${alice.token}` }, data: { message: "Unsigned bypass" } })).status()).toBe(401);
  await page.reload();
  await expect(page.getByText("Deterministic owned response", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByText("Private deterministic conversation", { exact: true })).toHaveCount(1);
  await page.locator("header details > summary").click();
  await page.getByRole("navigation",{ name: "Workspace" }).getByRole("link",{ name: "Conversations",exact: true }).click();
  await expect(page.getByRole("heading",{ name: "Conversations" })).toBeVisible();
  await expect(page).toHaveTitle("Conversations | AI App Jumpstart");
  await page.getByRole("button",{ name: "Rename",exact: true }).click();
  await page.getByLabel("Title",{ exact: true }).fill("Renamed private chat");
  await page.getByRole("button",{ name: "Save title",exact: true }).click();
  await expect(page.getByRole("link",{ name: "Renamed private chat" })).toBeVisible();
  expect((await request.patch(`/api/v1/conversations/${receipt.operationId}`,{ headers: { authorization: `Bearer ${alice.token}` },data: { revision: 1,title: "Stale overwrite" } })).status()).toBe(409);
  await page.getByRole("button",{ name: "Archive",exact: true }).click();
  await expect(page.getByText("No conversations yet.")).toBeVisible();
  await page.getByLabel("Show archived").check();
  await expect(page.getByRole("link",{ name: "Renamed private chat" })).toBeVisible();
  await page.getByRole("button",{ name: "Restore",exact: true }).click();
  await expect(page.getByText("No archived conversations yet.")).toBeVisible();
  await page.getByLabel("Show archived").uncheck();
  await page.getByRole("link",{ name: "Renamed private chat" }).click();
  await expect(page.getByText("Deterministic owned response",{ exact: true })).toHaveCount(1,{ timeout: 30_000 });
  await expectSettledTurn(page, request, alice.token, 1);
  await send(page, "Second owned turn");
  await expect(page.getByText("Deterministic owned response", { exact: true })).toHaveCount(2, { timeout: 30_000 });
  await expectSettledTurn(page, request, alice.token, 2);
  await send(page, "Third owned turn");
  await expect(page.getByText("Deterministic owned response", { exact: true })).toHaveCount(3, { timeout: 30_000 });
  await expectSettledTurn(page, request, alice.token, 3);
  await send(page, "This turn must be denied");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("daily_limit", { timeout: 30_000 });
  await expect(page.getByText("Deterministic owned response", { exact: true })).toHaveCount(3);
  const usage = await request.get("/api/v1/usage", { headers: { authorization: `Bearer ${alice.token}` } });
  expect(usage.status()).toBe(200); const usageView = await usage.json();
  expect(usageView).toMatchObject({ chargedMicros: 60, reservedMicros: 0, active: 0, unknownCosts: 3,dailyLimitMicros: 60 });
  expect(await runCli(["usage"],{ APP_API_URL: process.env.APP_ORIGIN!,APP_API_TOKEN: alice.token })).toEqual(usageView);
  const ledgerResponse = await request.get("/api/v1/usage/reservations?limit=100",{ headers: { authorization: `Bearer ${alice.token}` } });
  expect(ledgerResponse.status()).toBe(200);
  const aliceLedger = await ledgerResponse.json();
  expect(aliceLedger.items.length).toBeGreaterThan(0);
  expect(aliceLedger.items.every((row: { status: string }) => row.status === "settled")).toBe(true);
  expect(await runCli(["usage","reservations","--limit","100"],{ APP_API_URL: process.env.APP_ORIGIN!,APP_API_TOKEN: alice.token })).toEqual(aliceLedger);
  const correctionResponse = await request.get("/api/v1/usage/corrections?limit=100",{ headers: { authorization: `Bearer ${alice.token}` } });
  expect(correctionResponse.status()).toBe(200);
  const aliceCorrections = await correctionResponse.json();
  expect(aliceCorrections).toEqual({ items: [],nextCursor: null });
  expect(await runCli(["usage","corrections","--limit","100"],{ APP_API_URL: process.env.APP_ORIGIN!,APP_API_TOKEN: alice.token })).toEqual(aliceCorrections);
  const exportRecord = await request.post("/api/v1/records",{ headers: { authorization: `Bearer ${alice.token}` },data: { title: "Exported private record",content: "Only Alice may read this." } });
  expect(exportRecord.status()).toBe(201);
  const exportRecordId = (await exportRecord.json()).id;
  const exportUpload = await request.post("/api/v1/uploads",{ headers: {
    authorization: `Bearer ${alice.token}`, "content-type": "application/octet-stream",
    "x-upload-name": "private-export.txt", "x-upload-media-type": "text/plain",
  }, data: Buffer.from("Alice's quarantined bytes are not exportable.\n") });
  expect(exportUpload.status()).toBe(201);
  const exportUploadId = (await exportUpload.json()).id;
  const profileResponse = await request.get("/api/v1/account/profile",{ headers: { authorization: `Bearer ${alice.token}` } });
  expect(profileResponse.status()).toBe(200);
  const aliceProfile = await profileResponse.json();
  expect(aliceProfile).toMatchObject({ id: alice.id,email: alice.email });
  expect(await runCli(["account","profile"],{ APP_API_URL: process.env.APP_ORIGIN!,APP_API_TOKEN: alice.token })).toEqual(aliceProfile);
  const exportDirectory = await mkdtemp(join(tmpdir(),"jumpstart-account-export-"));
  try {
    const aliceFile = join(exportDirectory,"alice.ndjson"),bobFile = join(exportDirectory,"bob.ndjson");
    const env = { APP_API_URL: process.env.APP_ORIGIN! };
    expect(await runCli(["export","application",aliceFile],{ ...env,APP_API_TOKEN: alice.token })).toMatchObject({
      counts: { profile: 1,records: 1,conversations: 1,uploads: 1,uploadUsage: 1,reservations: aliceLedger.items.length,corrections: 0,usage: 1 },
    });
    const aliceLines = (await readFile(aliceFile,"utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(aliceLines.some(line => line.type === "record" && line.value.id === exportRecordId)).toBe(true);
    expect(aliceLines.some(line => line.type === "conversation" && line.value.operationId === receipt.operationId)).toBe(true);
    expect(aliceLines.some(line => line.type === "projection" && line.value.operationId === receipt.operationId)).toBe(true);
    expect(aliceLines.some(line => line.type === "upload" && line.value.id === exportUploadId && line.value.state === "quarantined")).toBe(true);
    expect(aliceLines.some(line => line.type === "upload_usage" && line.value.files === 1)).toBe(true);
    expect(aliceLines.find(line => line.type === "account_profile")?.value).toEqual(aliceProfile);
    expect(aliceLines.filter(line => line.type === "budget_reservation").map(line => line.value)).toEqual(aliceLedger.items);
    expect(await readFile(aliceFile,"utf8")).not.toContain("Alice's quarantined bytes are not exportable.");
    expect(await runCli(["export","application",bobFile],{ ...env,APP_API_TOKEN: bob.token })).toMatchObject({
      counts: { profile: 1,records: 0,conversations: 0,projections: 0,artifacts: 0,uploads: 0,uploadUsage: 1,reservations: 0,corrections: 0,usage: 1 },
    });
    expect(await readFile(bobFile,"utf8")).not.toContain(exportRecordId);
    expect(await readFile(bobFile,"utf8")).not.toContain(receipt.operationId);
    expect(await readFile(bobFile,"utf8")).not.toContain(exportUploadId);
    expect(await readFile(bobFile,"utf8")).not.toContain(alice.id);
  } finally { await rm(exportDirectory,{ recursive: true,force: true }); }
  const usageMcp = new Client({ name: "usage-browser-contract",version: "1" });
  try {
    await usageMcp.connect(new StreamableHTTPClientTransport(new URL("/api/mcp",process.env.APP_ORIGIN!),{ requestInit: { headers: { authorization: `Bearer ${alice.token}` } } }));
    const profileTool = await usageMcp.callTool({ name: "account_profile",arguments: {} });
    expect(profileTool.isError).not.toBe(true);
    expect(JSON.parse((profileTool.content as { text: string }[])[0].text)).toEqual(aliceProfile);
    const profileResource = await usageMcp.readResource({ uri: "account:///profile" });
    expect("text" in profileResource.contents[0] && JSON.parse(profileResource.contents[0].text)).toEqual(aliceProfile);
    const tool = await usageMcp.callTool({ name: "usage_get",arguments: {} });
    expect(tool.isError).not.toBe(true);
    expect(JSON.parse((tool.content as { text: string }[])[0].text)).toEqual(usageView);
    const ledgerTool = await usageMcp.callTool({ name: "usage_reservations",arguments: { limit: 100 } });
    expect(ledgerTool.isError).not.toBe(true);
    expect(JSON.parse((ledgerTool.content as { text: string }[])[0].text)).toEqual(aliceLedger);
    const correctionTool = await usageMcp.callTool({ name: "usage_corrections",arguments: { limit: 100 } });
    expect(correctionTool.isError).not.toBe(true);
    expect(JSON.parse((correctionTool.content as { text: string }[])[0].text)).toEqual(aliceCorrections);
    const resource = await usageMcp.readResource({ uri: "usage:///current" });
    expect("text" in resource.contents[0] && JSON.parse(resource.contents[0].text)).toEqual(usageView);
  } finally { await usageMcp.close(); }
  await page.goto("/usage");
  await expect(page.getByRole("heading",{ name: "AI usage" })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("value","60");
  await expect(page.getByText("Unknown-cost settlements")).toBeVisible();
  const denied = await request.post("/api/v1/conversations", { headers: { authorization: `Bearer ${alice.token}` }, data: { message: "New conversation beyond budget", operationId: randomUUID() } });
  expect(denied.status()).toBe(429);
  await page.goto("/account"); await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect.poll(() => new URL(page.url()).pathname).toBe("/login");
  await login(page, bob.email); await page.goto(path);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Conversation not found.");
  await expect(page.getByText("Private deterministic conversation", { exact: true })).toHaveCount(0);
  await page.goto("/usage");
  await expect(page.getByRole("progressbar")).toHaveAttribute("value","0");
});

test("a lost browser creation response recovers by status without duplicate dispatch", async ({ page, request }) => {
  const alice = await user(request); await login(page, alice.email);
  let creations = 0;
  await page.route("**/api/v1/conversations", async route => {
    creations++; await route.fetch(); await route.abort("connectionreset");
  });
  await send(page, "Recover my accepted request");
  await expect(page.getByText("Deterministic owned response", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  expect(creations).toBe(1);
  await page.reload();
  await expect(page.getByText("Deterministic owned response", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  const usage = await request.get("/api/v1/usage", { headers: { authorization: `Bearer ${alice.token}` } });
  expect(await usage.json()).toMatchObject({ chargedMicros: 20, unknownCosts: 1 });
  expect(creations).toBe(1);
});

test("a verified owner cancels a pending start before its runtime receipt", async ({ page, request }) => {
  const alice = await user(request), bob = await user(request), operationId = randomUUID();
  await login(page, alice.email);
  const failedBefore = (await runtimeReceipts("failures")).length;
  await receiptGate(false);
  try {
    const started = await request.post("/api/v1/conversations", { headers: { authorization: `Bearer ${alice.token}` }, data: { message: "Cancel before receipt", operationId } });
    expect(started.status()).toBe(202);
    expect(await started.json()).toMatchObject({ status: "starting", operationId });
    expect((await request.post(`/api/v1/conversations/${operationId}/cancel-start`, { headers: { authorization: `Bearer ${bob.token}` } })).status()).toBe(404);
    await page.goto(`/s/${operationId}`);
    await page.getByRole("button", { name: "Cancel pending start" }).click();
    await expect(page.getByRole("heading", { name: "Pending start cancelled" })).toBeVisible();
    expect((await (await request.get("/api/v1/usage", { headers: { authorization: `Bearer ${alice.token}` } })).json())).toMatchObject({ active: 0, reservedMicros: 0, chargedMicros: 0 });
    const repeat = await request.post(`/api/v1/conversations/${operationId}/cancel-start`, { headers: { authorization: `Bearer ${alice.token}` } });
    expect(repeat.status()).toBe(200);
    expect(await repeat.json()).toMatchObject({ status: "cancelled", operationId });
  } finally { await receiptGate(true); }
  await expect.poll(async () => (await runtimeReceipts("failures")).length,{ timeout: 15_000 }).toBeGreaterThan(failedBefore);
  expect((await runtimeReceipts("models")).filter(line => line.includes("Cancel before receipt"))).toHaveLength(0);
  expect((await request.get(`/api/v1/conversations/${operationId}`, { headers: { authorization: `Bearer ${alice.token}` } })).status()).toBe(409);
  const replay = await request.post("/api/v1/conversations", { headers: { authorization: `Bearer ${alice.token}` }, data: { message: "Cancel before receipt", operationId } });
  expect(replay.status()).toBe(409);
  await page.goto("/conversations");
  await expect(page.getByText("Cancel before receipt")).toBeVisible();
  await expect(page.getByText("Unavailable")).toBeVisible();
});

test("a verified owner fences budget admission lost before conversation reservation",async ({ page,request }) => {
  const alice = await user(request), bob = await user(request), operationId = randomUUID(),message = "Budget-only crash";
  await login(page,alice.email);
  expect((await request.get("/api/v1/usage",{ headers: { authorization: `Bearer ${alice.token}` } })).status()).toBe(200);
  seedBudgetOnly(alice.id,operationId,message);
  expect((await request.get(`/api/v1/conversations/${operationId}`,{ headers: { authorization: `Bearer ${alice.token}` } })).status()).toBe(404);
  expect((await request.post(`/api/v1/conversations/${operationId}/cancel-start`,{ headers: { authorization: `Bearer ${bob.token}` } })).status()).toBe(404);
  await page.goto(`/s/${operationId}`);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Conversation not found.");
  await page.getByRole("button",{ name: "Cancel pending start" }).click();
  await expect(page.getByRole("heading",{ name: "Pending start cancelled" })).toBeVisible();
  expect((await (await request.get("/api/v1/usage",{ headers: { authorization: `Bearer ${alice.token}` } })).json())).toMatchObject({ active: 0,reservedMicros: 0,chargedMicros: 0 });
  const replay = await request.post("/api/v1/conversations",{ headers: { authorization: `Bearer ${alice.token}` },data: { message,operationId } });
  expect(replay.status()).toBe(409);
  await page.goto("/conversations");
  await expect(page.getByText("Cancelled start")).toBeVisible();
  await expect(page.getByText("Unavailable")).toBeVisible();
});

test("structured form recovers a missing result projection, then saves and reopens owned fields",async ({ page,request }) => {
  const alice = await user(request),bob = await user(request);
  await login(page,alice.email);
  await page.goto("/structured");
  let creations = 0,recoveries = 0,hideResult = true;
  await page.route(/\/api\/v1\/conversations\/[^/]+\/events\?/,async route => {
    if (!hideResult) return route.continue();
    const response = await route.fetch();
    if (!hideResult) return route.fulfill({ response });
    const body = await response.json();
    await route.fulfill({ response,body: JSON.stringify({ ...body,items: body.items.filter((item: { payload: { kind: string } }) => item.payload.kind !== "result") }) });
  });
  await page.route(/\/api\/v1\/conversations\/[^/]+\/reconcile$/,async route => {
    const response = await route.fetch();
    if (response.ok()) { recoveries++;hideResult = false; }
    await route.fulfill({ response });
  });
  await page.route("**/api/v1/conversations",async route => {
    creations++;await route.fetch();await route.abort("connectionreset");
  });
  await page.getByLabel("Source material").fill("structured-fixture: summarize generic notes");
  await page.getByRole("button",{ name: "Generate fields" }).click();
  const id = new URL(page.url()).searchParams.get("id");
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  const events = `/api/v1/conversations/${id}/events`;
  await expect.poll(async () => {
    const response = await request.get(events,{ headers: { authorization: `Bearer ${alice.token}` } });
    const body = await response.json();
    if (body.items?.some((item: { payload: { kind: string } }) => item.payload.kind === "result")) return "result";
    const failure = body.items?.find((item: { payload: { kind: string;state?: string } }) => item.payload.kind === "run" && item.payload.state === "failed");
    return failure ? `failed:${failure.payload.code}` : "pending";
  },{ timeout: 30_000 }).toBe("result");
  await expect.poll(async () => {
    if (await page.getByLabel("Title",{ exact: true }).count()) return "complete";
    const alert = page.getByRole("main").getByRole("alert");
    return await alert.count() ? (await alert.textContent())?.trim() : "pending";
  },{ timeout: 30_000 }).toBe("complete");
  await expect(page.getByLabel("Title",{ exact: true })).toHaveValue("Deterministic title");
  expect(recoveries).toBe(1);
  await expect(page.getByLabel("Summary")).toHaveValue("Organized fixture notes.");
  await auditAccessibility(page, "editable structured result");
  await page.getByLabel("Title",{ exact: true }).fill("Reviewed title");
  await expect(page.getByLabel("Title",{ exact: true })).toHaveValue("Reviewed title");
  const projected = await request.get(events,{ headers: { authorization: `Bearer ${alice.token}` } });
  expect(projected.status()).toBe(200);
  expect((await projected.json()).items.some((item: { payload: { kind: string } }) => item.payload.kind === "result")).toBe(true);
  expect((await request.get(events,{ headers: { authorization: `Bearer ${bob.token}` } })).status()).toBe(404);
  await page.reload();
  await expect(page.getByLabel("Title",{ exact: true })).toHaveValue("Deterministic title",{ timeout: 30_000 });
  expect(creations).toBe(1);
  await page.getByLabel("Title",{ exact: true }).fill("Reviewed title");
  await page.getByRole("button",{ name: "Save draft" }).click();
  await expect.poll(() => new URL(page.url()).searchParams.get("draft")).toMatch(/^[a-f0-9-]{36}$/);
  const draftId = new URL(page.url()).searchParams.get("draft")!;
  expect(new URL(page.url()).searchParams.has("id")).toBe(false);
  const draftUrl = `/api/v1/records/${draftId}`;
  const saved = await request.get(draftUrl,{ headers: { authorization: `Bearer ${alice.token}` } });
  expect(saved.status()).toBe(200);
  const row = await saved.json();
  expect(row.revision).toBe(1);
  expect(JSON.parse(row.content)).toMatchObject({ kind: "structured-draft",schemaVersion: 1,sourceOperationId: id,value: { title: "Reviewed title",summary: "Organized fixture notes." } });
  expect((await request.get(draftUrl,{ headers: { authorization: `Bearer ${bob.token}` } })).status()).toBe(404);
  expect(await runCli(["get",draftId],{ APP_API_URL: process.env.APP_ORIGIN!,APP_API_TOKEN: alice.token })).toEqual(row);
  const mcp = new Client({ name: "structured-draft-contract",version: "1" });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL("/api/mcp",process.env.APP_ORIGIN!),{ requestInit: { headers: { authorization: `Bearer ${alice.token}` } } }));
    const result = await mcp.callTool({ name: "records_get",arguments: { id: draftId } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(row);
  } finally { await mcp.close(); }
  await page.reload();
  await expect(page.getByLabel("Title",{ exact: true })).toHaveValue("Reviewed title",{ timeout: 30_000 });
  expect(creations).toBe(1);
  await page.getByLabel("Summary").fill("Reviewed after saving.");
  await page.getByRole("button",{ name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("revision 2");
  const revised = await (await request.get(draftUrl,{ headers: { authorization: `Bearer ${alice.token}` } })).json();
  expect(revised.revision).toBe(2);
  expect(JSON.parse(revised.content).value.summary).toBe("Reviewed after saving.");
  await page.goto("/account");
  await page.getByRole("button",{ name: "Load records" }).click();
  await page.getByRole("link",{ name: "Open structured draft" }).click();
  await expect(page.getByLabel("Summary")).toHaveValue("Reviewed after saving.",{ timeout: 30_000 });
  const rejected = await request.post("/api/v1/conversations",{ headers: { authorization: `Bearer ${alice.token}` },data: { operationId: randomUUID(),message: "Unsafe schema",mode: "structured-record",outputSchema: { type: "string" } } });
  expect(rejected.status()).toBe(400);
});

test("an approved tool saves one private artifact; denial saves none",async ({ page,request }) => {
  const alice = await user(request),bob = await user(request);
  await login(page,alice.email);
  await send(page,"artifact-fixture: propose a private artifact");
  // The proposal renders before the turn finishes; audit the actionable state.
  await expect(page.getByRole("button",{ name: "Approve",exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("button",{ name: "Cancel",exact: true })).toBeEnabled();
  await expect(page.getByText("Exact approved plain-text payload.")).toBeVisible();
  await auditAccessibility(page, "artifact approval request");
  const artifactsUrl = "/api/v1/artifacts";
  expect((await (await request.get(artifactsUrl,{ headers: { authorization: `Bearer ${alice.token}` } })).json()).items).toEqual([]);
  await page.getByRole("button",{ name: "Approve",exact: true }).click();
  await expect.poll(async () => (await (await request.get(artifactsUrl,{ headers: { authorization: `Bearer ${alice.token}` } })).json()).items.length).toBe(1);
  const artifact = (await (await request.get(artifactsUrl,{ headers: { authorization: `Bearer ${alice.token}` } })).json()).items[0];
  expect(artifact).toMatchObject({ title: "Fixture artifact",content: "Exact approved plain-text payload.",mediaType: "text/plain" });
  expect((await request.get(`/api/v1/artifacts/${artifact.id}`,{ headers: { authorization: `Bearer ${bob.token}` } })).status()).toBe(404);
  expect((await request.get(`/api/v1/artifacts/${artifact.id}/download`,{ headers: { authorization: `Bearer ${bob.token}` } })).status()).toBe(404);
  expect((await request.delete(`/api/v1/artifacts/${artifact.id}`,{ headers: { authorization: `Bearer ${bob.token}` } })).status()).toBe(404);
  expect((await (await request.get(artifactsUrl,{ headers: { authorization: `Bearer ${bob.token}` } })).json()).items).toEqual([]);
  expect((await request.post(artifactsUrl,{ headers: { authorization: `Bearer ${alice.token}` },data: { title: "Forged",content: "No approval" } })).status()).toBe(405);
  const env = { APP_API_URL: process.env.APP_ORIGIN!,APP_API_TOKEN: alice.token };
  expect(await runCli(["artifacts","get",artifact.id],env)).toEqual(artifact);
  expect(await runCli(["artifacts","list"],env)).toMatchObject({ items: [{ id: artifact.id }] });
  const exported = await request.get(`/api/v1/artifacts/${artifact.id}/download`,{ headers: { authorization: `Bearer ${alice.token}` } });
  expect(exported.status()).toBe(200);
  expect(exported.headers()["content-type"]).toContain("text/plain");
  expect(exported.headers()["content-disposition"]).toContain(`artifact-${artifact.id}.txt`);
  expect(await exported.text()).toBe(artifact.content);
  const mcp = new Client({ name: "artifact-browser-contract",version: "1" });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL("/api/mcp",env.APP_API_URL),{ requestInit: { headers: { authorization: `Bearer ${alice.token}` } } }));
    const result = await mcp.callTool({ name: "artifacts_get",arguments: { id: artifact.id } });
    expect(result.isError).not.toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual(artifact);
  } finally { await mcp.close(); }
  await expect(page.getByText("Artifact proposal resolved.")).toBeVisible({ timeout: 30_000 });
  await page.locator("header details > summary").click();
  await page.getByRole("navigation",{ name: "Workspace" }).getByRole("link",{ name: "Artifacts",exact: true }).click();
  await expect(page.getByRole("heading",{ name: "Artifacts" })).toBeVisible();
  await expect(page).toHaveTitle("Artifacts | AI App Jumpstart");
  await expect(page.getByRole("heading",{ name: "Fixture artifact" })).toBeVisible();
  await page.getByText("View text").click();
  await expect(page.getByText("Exact approved plain-text payload.")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button",{ name: "Download .txt" }).click();
  expect((await download).suggestedFilename()).toBe(`artifact-${artifact.id}.txt`);
  page.once("dialog",dialog => dialog.accept());
  await page.getByRole("button",{ name: "Delete",exact: true }).click();
  await expect(page.getByRole("heading",{ name: "Fixture artifact" })).toHaveCount(0);
  expect((await request.get(`/api/v1/artifacts/${artifact.id}`,{ headers: { authorization: `Bearer ${alice.token}` } })).status()).toBe(404);
  expect((await (await request.get(artifactsUrl,{ headers: { authorization: `Bearer ${alice.token}` } })).json()).items).toEqual([]);
  await expect(runCli(["artifacts","get",artifact.id],env)).rejects.toThrow("HTTP 404");
  const denying = await user(request);
  await page.goto("/account"); await page.getByRole("button",{ name: "Sign out",exact: true }).click();
  await login(page,denying.email);
  await send(page,"artifact-fixture: deny this private artifact");
  await expect(page.getByRole("button",{ name: "Cancel",exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button",{ name: "Cancel",exact: true }).click();
  await expect(page.getByText("Artifact proposal resolved.")).toBeVisible({ timeout: 30_000 });
  expect((await (await request.get(artifactsUrl,{ headers: { authorization: `Bearer ${denying.token}` } })).json()).items).toEqual([]);
});

test("hosted smoke verifies two Supabase accounts and an owned agent turn",async ({ request }) => {
  const alice = await user(request),bob = await user(request);
  const result = await runHostedSmoke({ url: process.env.APP_ORIGIN!,token: alice.token,otherToken: bob.token,accounts: true,agent: true,browser: true });
  expect(result.agent?.operationId).toMatch(/^[a-f0-9-]{36}$/);
  expect(result.browser).toBe(true);
});

test("real account tokens share history across production REST, MCP resources/tools and CLI",async ({ request }) => {
  const alice = await user(request), bob = await user(request), operationId = randomUUID();
  const created = await request.post("/api/v1/conversations",{ headers: { authorization: `Bearer ${alice.token}` },data: { operationId,message: "Shared metadata across transports" } });
  expect([200,202]).toContain(created.status());
  await expect.poll(async () => (await (await request.get(`/api/v1/conversations/${operationId}`,{ headers: { authorization: `Bearer ${alice.token}` } })).json()).status).toBe("active");
  const client = new Client({ name: "history-browser-contract",version: "1" });
  const env = { APP_API_URL: process.env.APP_ORIGIN!,APP_API_TOKEN: alice.token };
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-chat-cli-"));
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL("/api/mcp",env.APP_API_URL),{ requestInit: { headers: { authorization: `Bearer ${alice.token}` } } }));
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain("conversations_update");
    const updated = await client.callTool({ name: "conversations_update",arguments: { operationId,patch: { revision: 1,title: "Title from MCP" } } });
    expect(updated.isError).not.toBe(true);
    const metadata = await request.get(`/api/v1/conversations/${operationId}/metadata`,{ headers: { authorization: `Bearer ${alice.token}` } });
    expect(metadata.status()).toBe(200); expect(metadata.headers()["cache-control"]).toBe("no-store");
    const row = await metadata.json(); expect(row).toMatchObject({ title: "Title from MCP",revision: 2 });
    expect(row.sessionId).toBeUndefined(); expect(row.requestHash).toBeUndefined();
    expect(await runCli(["conversations","get",operationId],env)).toEqual(row);
    const file = join(directory,"patch.json"); await writeFile(file,JSON.stringify({ revision: 2,archived: true }));
    expect(await runCli(["conversations","update",operationId,file],env)).toMatchObject({ archived: true,revision: 3 });
    const resource = await client.readResource({ uri: `conversations:///${operationId}` });
    expect("text" in resource.contents[0] && JSON.parse(resource.contents[0].text)).toMatchObject({ title: "Title from MCP",archived: true,revision: 3 });
    expect(await runCli(["conversations","list","--archived"],env)).toMatchObject({ items: [{ operationId,revision: 3 }] });
    const stream = await client.callTool({ name: "conversations_events",arguments: { operationId } });
    expect(stream.isError).not.toBe(true);
    const entries = JSON.parse((stream.content as { text: string }[])[0].text);
    expect(entries).toMatchObject({ source: "eve-stream",schemaVersion: 1 });
    expect(JSON.stringify(entries)).toContain("Shared metadata across transports");
    expect(await runCli(["conversations","events",operationId],env)).toMatchObject({ schemaVersion: 1,source: "eve-stream" });
    const sourceResponse = await request.get(`/api/v1/conversations/${operationId}/source-events?limit=1`,{
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(sourceResponse.status()).toBe(200);
    expect(sourceResponse.headers()["cache-control"]).toBe("no-store");
    const sourcePage = sourceEventPage.parse(await sourceResponse.json());
    expect(sourcePage).toMatchObject({ schemaVersion: 1,source: "eve-durable-stream",complete: false });
    expect(sourcePage.items).toHaveLength(1);
    expect(sourcePage.items[0].sourceIndex).toBeGreaterThanOrEqual(0);
    expect(sourcePage.nextIndex).toBeGreaterThan(sourcePage.items[0].sourceIndex);
    expect(sourceEventPage.parse(await runCli(["conversations","source-events",operationId],env)).items[0]).toEqual(sourcePage.items[0]);
    const sourceTool = await client.callTool({ name: "conversations_source_events",arguments: { operationId } });
    expect(sourceTool.isError).not.toBe(true);
    expect(JSON.parse((sourceTool.content as { text: string }[])[0].text).items[0]).toEqual(sourcePage.items[0]);
    expect(await runCli(["conversations","reconcile",operationId],env)).toMatchObject({ complete: true,checkpoint: expect.any(Number) });
    const reconcileTool = await client.callTool({ name: "conversations_reconcile",arguments: { operationId } });
    expect(reconcileTool.isError).not.toBe(true);
    expect(JSON.parse((reconcileTool.content as { text: string }[])[0].text)).toMatchObject({ processed: 0,complete: true });
    expect((await request.get(`/api/v1/conversations/${operationId}/source-events`,{
      headers: { authorization: `Bearer ${bob.token}` },
    })).status()).toBe(404);
    await expect(runCli(["conversations","get",operationId],{ ...env,APP_API_TOKEN: bob.token })).rejects.toThrow("HTTP 404");
    await expect(runCli(["conversations","update",operationId,file],env)).rejects.toThrow("HTTP 409");
    const logout = await request.post(`${auth}/auth/v1/logout?scope=local`,{ headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY!,authorization: `Bearer ${alice.token}` } });
    expect(logout.status()).toBe(204);
    await expect(client.listTools()).rejects.toThrow();
  } finally { await client.close(); await rm(directory,{ recursive: true }); }
});

test("expired credentials, cross-origin requests and caller-owned price/model settings are rejected", async ({ request }) => {
  const alice = await user(request);
  const data = { message: "Request", operationId: randomUUID() };
  expect((await request.post("/api/v1/conversations", { data })).status()).toBe(401);
  expect((await request.get("/api/v1/conversations")).status()).toBe(401);
  expect((await request.get("/api/v1/conversations?limit=51",{ headers: { authorization: `Bearer ${alice.token}` } })).status()).toBe(400);
  expect((await request.post("/api/v1/conversations", { headers: { authorization: `Bearer ${alice.token}`, origin: "https://untrusted.example" }, data })).status()).toBe(403);
  expect((await request.post("/api/v1/conversations", { headers: { authorization: `Bearer ${alice.token}` }, data: { ...data, model: "unrestricted", estimateMicros: 0 } })).status()).toBe(400);
  const logout = await request.post(`${auth}/auth/v1/logout?scope=local`, { headers: { apikey: process.env.SUPABASE_PUBLISHABLE_KEY!, authorization: `Bearer ${alice.token}` } });
  expect(logout.status()).toBe(204);
  expect((await request.post("/api/v1/conversations", { headers: { authorization: `Bearer ${alice.token}` }, data })).status()).toBe(401);
});

test("a rejected start shows the error and New chat clears its pending state", async ({ page, request }) => {
  const alice = await user(request); await login(page, alice.email);
  let requests = 0;
  await page.route("**/api/v1/conversations", async route => {
    requests++;
    if (requests === 1) return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: { message: "Temporary request limit." } }) });
    await route.continue();
  });
  await send(page, "Rejected start");
  await expect(page.getByRole("main").getByRole("alert")).toHaveText("Temporary request limit.");
  await page.getByRole("link", { name: "New chat", exact: true }).click();
  await expect(page.getByPlaceholder("Send a message…")).toBeVisible();
  await send(page, "Explicitly start a new conversation");
  await expect(page.getByText("Deterministic owned response", { exact: true })).toHaveCount(1, { timeout: 30_000 });
  expect(requests).toBe(2);
});

test("enabled workspace screens pass automated accessibility rules", async ({ page, request }) => {
  const alice = await user(request);
  await login(page, alice.email);
  await expect(page.getByPlaceholder("Send a message…")).toBeVisible();
  await auditAccessibility(page, "empty chat");

  for (const [path, heading] of [["/conversations", "Conversations"], ["/structured", "Structured result"], ["/artifacts", "Artifacts"], ["/usage", "AI usage"]]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await auditAccessibility(page, path);
  }
});
