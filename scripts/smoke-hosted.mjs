import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client as EveClient } from "eve/client";
import { checkedBrowserAccounts,verifyBrowserAccounts,accountBrowserRead } from "./helpers/hosted-account-browser.mjs";
import { checkDeployedOpenApi } from "./helpers/hosted-openapi.mjs";

function targetOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Set APP_API_URL to an HTTP(S) origin."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_API_URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Use HTTPS for a remote deployment.");
  }
  return url.origin;
}

function requireStagingAcknowledgment(origin, target) {
  const hostname = new URL(origin).hostname;
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return;
  if (target !== "staging") {
    throw new Error("Refusing remote hosted smoke writes. Verify APP_API_URL is an isolated staging deployment, then set APP_SMOKE_TARGET=staging.");
  }
}

function message(error) { return error instanceof Error ? error.message : "Unknown error"; }

async function cliJson(origin, token, args) {
  const executable = fileURLToPath(new URL("./app-cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", executable, ...args], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, APP_API_URL: origin, APP_API_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-100_000); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-1000); });
  const [code, signal] = await once(child, "exit");
  if (code !== 0 || signal) throw new Error(`CLI read failed (${signal ?? code}): ${stderr.replaceAll(token, "[redacted]")}`);
  return JSON.parse(stdout);
}

function checkedRequestWindow(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Request-window response is invalid");
  assert.deepEqual(Object.keys(value), ["snapshot"], "Request-window response has unexpected fields");
  const snapshot = value.snapshot;
  assert.ok(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot), "Active request admission has no owner window");
  assert.deepEqual(Object.keys(snapshot).sort(), ["admitted", "windowStartAt"], "Request window has unexpected fields");
  const bucket = Date.parse(snapshot.windowStartAt);
  assert.ok(Number.isSafeInteger(bucket) && bucket % 60_000 === 0 &&
    new Date(bucket).toISOString() === snapshot.windowStartAt, "Request-window timestamp is invalid");
  assert.ok(Number.isSafeInteger(snapshot.admitted) && snapshot.admitted >= 1 && snapshot.admitted <= 10_000,
    "Request-window admitted count is invalid");
  return snapshot;
}

async function runRequestLimitSmoke({ request, origin, token, authorized, other, protection }) {
  const read = async headers => {
    const response = await request("/api/v1/account/request-limit", { headers });
    assert.equal(response.status, 200, "Registered-user request-window read failed");
    return checkedRequestWindow(await response.json());
  };
  let advanced = false;
  for (let attempt = 0; attempt < 3 && !advanced; attempt++) {
    const before = await read(authorized),after = await read(authorized);
    if (before.windowStartAt === after.windowStartAt) {
      assert.ok(after.admitted > before.admitted, "Authenticated request admission did not advance");
      advanced = true;
    }
  }
  assert.ok(advanced, "Request window crossed the UTC minute during all admission checks");
  await read(other);
  checkedRequestWindow(await cliJson(origin,token,["account","request-limit"]));
  const client = new Client({ name: "hosted-request-limit-smoke",version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
      requestInit: { headers: { ...protection,...authorized } },
    }));
    const tool = await client.callTool({ name: "account_request_limit",arguments: {} });
    assert.notEqual(tool.isError,true,"MCP request-window read failed");
    checkedRequestWindow(JSON.parse(tool.content[0].text));
    const resource = await client.readResource({ uri: "account:///request-limit" });
    checkedRequestWindow(JSON.parse(resource.contents[0].text));
  } finally { await client.close(); }
}

async function runUploadSmoke({ request, origin, token, otherToken, protection, authorized, other, ownerClient, download }) {
  const marker = randomUUID(), name = `hosted-smoke-${marker}.txt`;
  const bytes = Buffer.from(`Private hosted upload smoke ${marker}\n`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const uploadId = /^[0-9a-f-]{36}$/i;
  const checkMetadata = (row, id) => {
    assert.ok(row && typeof row === "object", "Private upload metadata is invalid");
    assert.ok(row.id === id, "Private upload ID changed");
    assert.ok(row.name === name, "Private upload name changed");
    assert.equal(row.size, bytes.length, "Private upload size changed");
    assert.ok(row.sha256 === digest, "Private upload digest changed");
    assert.equal(row.state, "quarantined", "Private upload left quarantine before review");
    assert.ok(!JSON.stringify(row).includes(bytes.toString("utf8")), "Private bytes appeared in upload metadata");
  };
  console.log(`Temporary upload: ${name}`);
  let upload, failure, cleanupFailure, foreignClient;
  try {
    const created = await request("/api/v1/uploads", {
      method: "POST", body: bytes, timeoutMs: 60_000,
      headers: { ...authorized, "content-type": "application/octet-stream",
        "x-upload-name": encodeURIComponent(name), "x-upload-media-type": "text/plain" },
    });
    assert.equal(created.status, 201, "Private upload creation failed");
    const row = await created.json();
    assert.ok(uploadId.test(row?.id), "Private upload returned an invalid ID");
    checkMetadata(row, row.id);
    upload = row;
    const path = `/api/v1/uploads/${upload.id}`;
    const ownRead = await request(path, { headers: authorized });
    assert.equal(ownRead.status, 200, "Owner cannot read private upload metadata");
    checkMetadata(await ownRead.json(), upload.id);
    assert.equal((await request(path)).status, 401, "Anonymous caller can read private upload metadata");
    assert.equal((await request(path, { headers: other })).status, 404, "Other owner can read private upload metadata");
    assert.equal((await request(path, { method: "DELETE", headers: other })).status, 404,
      "Other owner can delete private upload");
    const otherList = await request("/api/v1/uploads", { headers: other });
    assert.equal(otherList.status, 200, "Other owner cannot list private uploads");
    assert.ok(!(await otherList.json()).items.some(item => item.id === upload.id),
      "Other owner can list private upload metadata");
    checkMetadata(await cliJson(origin, token, ["uploads", "get", upload.id]), upload.id);
    const ownerMcp = await ownerClient.callTool({ name: "uploads_get", arguments: { id: upload.id } });
    assert.notEqual(ownerMcp.isError, true, "Owner MCP upload read failed");
    checkMetadata(JSON.parse(ownerMcp.content[0].text), upload.id);
    foreignClient = new Client({ name: "hosted-upload-isolation", version: "1" });
    await foreignClient.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
      requestInit: { headers: { ...protection, authorization: `Bearer ${otherToken}` } },
    }));
    const foreignMcp = await foreignClient.callTool({ name: "uploads_get", arguments: { id: upload.id } });
    assert.equal(foreignMcp.isError, true, "Other owner can read private upload through MCP");
    if (download) {
      assert.equal((await request(`${path}/download`, { headers: other })).status, 404,
        "Other owner can download private upload");
      const ownDownload = await request(`${path}/download`, { headers: authorized, timeoutMs: 60_000 });
      assert.equal(ownDownload.status, 200, "Owner scan-on-read download failed");
      assert.equal(ownDownload.headers.get("content-type"), "application/octet-stream");
      const received = Buffer.from(await ownDownload.arrayBuffer());
      assert.equal(received.length, bytes.length, "Scanned private download size changed");
      assert.ok(createHash("sha256").update(received).digest("hex") === digest,
        "Scanned private download bytes changed");
    }
  } catch (error) { failure = error; }
  finally {
    try { await foreignClient?.close(); } catch (error) { cleanupFailure = error; }
    if (!upload) {
      // A lost POST response may have stored bytes. Reconcile by the unique
      // filename and digest; never retry the write or delete another object.
      try {
        const listed = await request("/api/v1/uploads", { headers: authorized });
        if (listed.status === 200) {
          const matches = (await listed.json()).items.filter(item => item.name === name && item.sha256 === digest && uploadId.test(item.id));
          if (matches.length === 1) upload = matches[0];
          else if (matches.length > 1) throw new Error("Temporary upload cleanup found duplicate matches");
        }
      } catch (error) { cleanupFailure = error; }
    }
    if (upload) {
      try {
        const path = `/api/v1/uploads/${upload.id}`;
        const deleted = await request(path, { method: "DELETE", headers: authorized });
        assert.equal(deleted.status, 204, "Temporary upload cleanup failed");
        assert.equal((await request(path, { headers: authorized })).status, 404,
          "Temporary upload remains visible after deletion");
      } catch (error) { cleanupFailure = error; }
    }
  }
  if (failure && cleanupFailure) throw new Error(`${message(failure)}; cleanup: ${message(cleanupFailure)}`);
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return upload.id;
}

async function browserRead({ origin, token, otherToken, protection, title }) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    if (Object.keys(protection).length) await context.route("**/*", route => {
      const target = new URL(route.request().url());
      return target.origin === origin
        ? route.continue({ headers: { ...route.request().headers(), ...protection } })
        : route.continue();
    });
    const page = await context.newPage();
    const response = await page.goto(`${origin}/records`, { waitUntil: "domcontentloaded" });
    assert.equal(response?.status(), 200, "Browser records page failed");
    const connect = async (accessToken) => {
      await page.getByLabel("Access token").fill(accessToken);
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await page.getByRole("button", { name: "Disconnect", exact: true }).waitFor({ state: "visible" });
    };
    await connect(token);
    await page.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await connect(token);
    await page.getByRole("heading", { name: title, exact: true }).waitFor({ state: "visible" });
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    await connect(otherToken);
    assert.equal(await page.getByRole("heading", { name: title, exact: true }).count(), 0,
      "Other owner can see the temporary record in the browser");
  } catch (error) {
    const redacted = [token, otherToken, ...Object.values(protection)]
      .reduce((value, secret) => value.replaceAll(secret, "[redacted]"), message(error));
    throw new Error(`Browser records smoke failed: ${redacted}`);
  } finally { await browser.close(); }
}

function checkedModelReceipt({ expectedModel,maxObservedMicros }) {
  assert.ok(typeof expectedModel === "string" && expectedModel.trim() === expectedModel && expectedModel.length > 0 && expectedModel.length <= 200,
    "APP_SMOKE_EXPECTED_MODEL must be an exact nonempty model ID");
  assert.ok(Number.isSafeInteger(maxObservedMicros) && maxObservedMicros > 0 && maxObservedMicros <= 1_000_000_000_000,
    "APP_SMOKE_MAX_OBSERVED_MICROS must be a positive integer");
}

export async function verifyHostedModelReceipt({ request, token, operationId, sourceModels, expectedModel, maxObservedMicros, timeoutMs = 30_000 }) {
  checkedModelReceipt({ expectedModel,maxObservedMicros });
  assert.deepEqual([...sourceModels].sort(),[expectedModel],"Hosted source stream did not use only the expected model");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let cursor = null,receipt = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const query = new URLSearchParams({ limit: "100", ...(cursor === null ? {} : { cursor }) });
      const response = await request(`/api/v1/usage/reservations?${query}`,{
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: Math.max(1,Math.min(5000,deadline-Date.now())),
      });
      assert.equal(response.status,200,"Owner reservation history failed");
      const page = await response.json();
      assert.ok(Array.isArray(page.items) && (page.nextCursor === null || typeof page.nextCursor === "string"),
        "Owner reservation page is invalid");
      receipt = page.items.find(item => item.operationId === operationId) ?? null;
      if (receipt || page.nextCursor === null) break;
      assert.notEqual(page.nextCursor,cursor,"Owner reservation cursor did not advance");
      cursor = page.nextCursor;
    }
    if (receipt?.status === "settled") {
      assert.ok(Number.isSafeInteger(receipt.actualMicros) && receipt.actualMicros > 0,
        "Hosted model cost is unknown or zero");
      assert.ok(receipt.actualMicros <= maxObservedMicros,"Hosted model cost exceeded the observed-cost threshold");
      return { modelId: expectedModel,actualMicros: receipt.actualMicros };
    }
    await new Promise(resolve => setTimeout(resolve,250));
  }
  throw new Error(`Hosted model cost did not settle for operation ${operationId}`);
}

async function runAgentSmoke({ origin, token, otherToken, protection, request, modelReceipt, followUp }) {
  const operationId = randomUUID();
  const marker = followUp ? randomUUID() : null;
  const prompt = marker
    ? `Reply with one short greeting. Do not use tools. Remember this code for my next turn: hosted-follow-up-code: ${marker}.`
    : "Reply with one short greeting. Do not use tools.";
  console.log(`Agent smoke operation: ${operationId}`);
  const authorized = { authorization: `Bearer ${token}` };
  const other = { authorization: `Bearer ${otherToken}` };
  const created = await request("/api/v1/conversations", {
    method: "POST", headers: { ...authorized, "content-type": "application/json" },
    body: JSON.stringify({ operationId, message: prompt }),
  });
  assert.ok([200, 202].includes(created.status), `Agent creation failed (HTTP ${created.status})`);
  const initial = await created.json();
  assert.equal(initial.operationId, operationId, "Agent creation returned a different operation");

  // A starting operation may already have been dispatched. Never repeat POST.
  const deadline = Date.now() + 30_000;
  let conversation = initial;
  while (conversation.status === "starting" && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 250));
    const response = await request(`/api/v1/conversations/${operationId}`, { headers: authorized });
    assert.equal(response.status, 200, `Agent binding failed (HTTP ${response.status})`);
    conversation = await response.json();
  }
  assert.equal(conversation.status, "active", `Agent binding did not become active for ${operationId}`);
  assert.ok(typeof conversation.sessionId === "string" && conversation.sessionId.length > 0);
  assert.equal((await request(`/api/v1/conversations/${operationId}`, { headers: other })).status, 404,
    "Other account can read the agent conversation");
  const streamPath = `/eve/v1/session/${encodeURIComponent(conversation.sessionId)}/stream`;
  assert.equal((await request(streamPath, { headers: other })).status, 401,
    "Other account can stream the agent session");

  const client = new EveClient({ host: origin, auth: { bearer: token }, headers: protection, redirect: "error" });
  const session = client.sessions.attach(conversation.sessionId);
  const seen = new Set();
  let finalMessage = false;
  try {
    const signal = AbortSignal.timeout(120_000);
    for await (const event of session.stream({ signal })) {
      seen.add(event.type);
      if (event.type === "message.completed" && typeof event.data.message === "string" && event.data.message.trim()) finalMessage = true;
      if (event.type === "turn.failed" || event.type === "turn.cancelled" || event.type === "session.failed") {
        throw new Error(`Agent turn ended with ${event.type}`);
      }
      if (event.type === "session.waiting") break;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Agent turn ended with ")) throw error;
    throw new Error(`Agent stream failed for operation ${operationId} (${error instanceof Error ? error.name : "unknown"}).`);
  }
  for (const type of ["step.completed", "turn.completed", "session.waiting"]) {
    assert.ok(seen.has(type), `Agent stream missed ${type} for operation ${operationId}`);
  }
  assert.ok(finalMessage, `Agent stream had no finalized response for operation ${operationId}`);
  const projectionPath = `/api/v1/conversations/${operationId}/events`;
  assert.equal((await request(projectionPath, { headers: other })).status, 404,
    "Other account can read agent projections");
  const projectionDeadline = Date.now() + 15_000;
  let projected = false;
  do {
    let cursor = null, completed = false, answered = false;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const query = new URLSearchParams({ limit: "50", ...(cursor === null ? {} : { after: String(cursor) }) });
      const response = await request(`${projectionPath}?${query}`, { headers: authorized });
      assert.equal(response.status, 200, `Agent projections failed (HTTP ${response.status})`);
      const page = await response.json();
      assert.ok(Array.isArray(page.items), "Agent projection page is invalid");
      for (const entry of page.items) {
        if (entry.payload?.kind === "run" && entry.payload.state === "completed") completed = true;
        if (entry.payload?.kind === "message" && entry.payload.role === "assistant" &&
            entry.payload.parts?.some(part => part.type === "text" && part.text?.trim())) answered = true;
      }
      if (page.nextCursor === null) break;
      assert.ok(page.items.length && Number.isSafeInteger(page.nextCursor) && page.nextCursor > (cursor ?? 0),
        "Agent projection pagination did not advance");
      cursor = page.nextCursor;
    }
    projected = completed && answered;
    if (!projected) await new Promise(resolve => setTimeout(resolve, 250));
  } while (!projected && Date.now() < projectionDeadline);
  assert.ok(projected, `Completed agent turn was not projected for operation ${operationId}`);
  const sourcePath = `/api/v1/conversations/${operationId}/source-events`;
  assert.equal((await request(sourcePath, { headers: other })).status, 404,
    "Other account can read the agent source stream");
  let sourceIndex = 0, sourceEvents = 0, lastSelected = -1;
  let sourceAnswer = false, sourceCompleted = false, sourceTail = false;
  const sourceModels = new Set();
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const query = new URLSearchParams({ startIndex: String(sourceIndex), limit: "50" });
    const response = await request(`${sourcePath}?${query}`, { headers: authorized });
    assert.equal(response.status, 200, `Agent source stream failed (HTTP ${response.status})`);
    const page = await response.json();
    assert.equal(page.schemaVersion, 1);
    assert.equal(page.source, "eve-durable-stream");
    assert.ok(Array.isArray(page.items) && Number.isSafeInteger(page.scanned) && page.scanned >= 0);
    assert.equal(page.nextIndex, sourceIndex + page.scanned, "Source cursor skipped or repeated events");
    for (const entry of page.items) {
      assert.ok(Number.isSafeInteger(entry.sourceIndex) && entry.sourceIndex > lastSelected &&
        entry.sourceIndex >= sourceIndex && entry.sourceIndex < page.nextIndex, "Source events are out of order");
      lastSelected = entry.sourceIndex;
      sourceEvents++;
      if (entry.payload?.kind === "message" && entry.payload.role === "assistant" &&
        entry.payload.parts?.some(part => part.type === "text" && part.text?.trim())) sourceAnswer = true;
      if (entry.payload?.kind === "run" && entry.payload.state === "completed") sourceCompleted = true;
      if (entry.payload?.kind === "model" && typeof entry.payload.modelId === "string") sourceModels.add(entry.payload.modelId);
    }
    sourceIndex = page.nextIndex;
    if (page.complete) { sourceTail = true; break; }
    assert.ok(page.scanned > 0, "Agent source cursor did not advance");
  }
  assert.ok(sourceTail && sourceAnswer && sourceCompleted, `Agent source stream is incomplete for operation ${operationId}`);
  const receipt = modelReceipt ? await verifyHostedModelReceipt({ request,token,operationId,sourceModels,...modelReceipt }) : undefined;
  let followUpPrompt;
  if (marker) {
    followUpPrompt = "What was the code I gave you in my previous message? Reply with only that code; do not use tools.";
    let followUpTurn;
    try { followUpTurn = await (await session.send(followUpPrompt)).result(); }
    catch (error) {
      throw new Error(`Agent follow-up failed for operation ${operationId} (${error instanceof Error ? error.name : "unknown"}).`);
    }
    assert.equal(followUpTurn.sessionId,conversation.sessionId,"Agent follow-up changed session");
    assert.notEqual(followUpTurn.status,"failed",`Agent follow-up failed for operation ${operationId}`);
    assert.ok(followUpTurn.events.some(event => event.type === "turn.completed"),"Agent follow-up did not complete a turn");
    assert.ok(followUpTurn.message?.includes(marker),`Agent follow-up did not recall the first-turn code for operation ${operationId}`);
    const followUpDeadline = Date.now() + 15_000;
    let projectedFollowUp = false;
    do {
      let cursor = null;
      for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
        const query = new URLSearchParams({ limit: "50", ...(cursor === null ? {} : { after: String(cursor) }) });
        const response = await request(`${projectionPath}?${query}`, { headers: authorized });
        assert.equal(response.status,200,"Agent follow-up projections failed");
        const page = await response.json();
        assert.ok(Array.isArray(page.items),"Agent follow-up projection page is invalid");
        projectedFollowUp ||= page.items.some(entry => entry.payload?.kind === "message" && entry.payload.role === "assistant" &&
          entry.payload.parts?.some(part => part.type === "text" && part.text?.includes(marker)));
        if (page.nextCursor === null) break;
        assert.ok(page.items.length && Number.isSafeInteger(page.nextCursor) && page.nextCursor > (cursor ?? 0),
          "Agent follow-up projection pagination did not advance");
        cursor = page.nextCursor;
      }
      if (!projectedFollowUp) await new Promise(resolve => setTimeout(resolve,250));
    } while (!projectedFollowUp && Date.now() < followUpDeadline);
    assert.ok(projectedFollowUp,`Agent follow-up was not projected for operation ${operationId}`);
    let sourceFollowUp = false, sourceTail = false;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const query = new URLSearchParams({ startIndex: String(sourceIndex),limit: "50" });
      const response = await request(`${sourcePath}?${query}`, { headers: authorized });
      assert.equal(response.status,200,"Agent follow-up source stream failed");
      const page = await response.json();
      assert.ok(Array.isArray(page.items) && Number.isSafeInteger(page.scanned) && page.scanned >= 0,
        "Agent follow-up source page is invalid");
      assert.equal(page.nextIndex,sourceIndex + page.scanned,"Agent follow-up source cursor skipped events");
      sourceFollowUp ||= page.items.some(entry => entry.payload?.kind === "message" && entry.payload.role === "assistant" &&
        entry.payload.parts?.some(part => part.type === "text" && part.text?.includes(marker)));
      sourceEvents += page.items.length;
      sourceIndex = page.nextIndex;
      if (page.complete) { sourceTail = true; break; }
      assert.ok(page.scanned > 0,"Agent follow-up source cursor did not advance");
    }
    assert.ok(sourceTail && sourceFollowUp,`Agent follow-up is missing from the durable source stream for operation ${operationId}`);
  }
  return { operationId, sessionId: conversation.sessionId, sourceEvents, sourceIndex,receipt,prompt,followUpPrompt,followUpMarker: marker };
}

/**
 * @param {{url: string,token: string,otherToken: string,target?: string,accounts?: boolean,agent?: boolean,agentFollowUp?: boolean,browser?: boolean,accountBrowser?: boolean,requestLimit?: boolean,uploads?: boolean,uploadDownload?: boolean,contract?: boolean,modelReceipt?: {expectedModel: string,maxObservedMicros: number},browserAccounts?: import("./helpers/hosted-account-browser.mjs").AccountBrowserCredentials}} options
 */
export async function runHostedSmoke({ url, token, otherToken, target = process.env.APP_SMOKE_TARGET, accounts = false, agent = false, agentFollowUp = false,browser = false,accountBrowser = false,requestLimit = false,uploads = false,uploadDownload = false,contract = false,modelReceipt,browserAccounts }) {
  const origin = targetOrigin(url);
  requireStagingAcknowledgment(origin, target);
  if (agent && !accounts) throw new Error("Agent smoke requires the two-account mode.");
  if (agentFollowUp && !agent) throw new Error("Agent follow-up smoke requires an explicit agent turn.");
  if (modelReceipt && !agent) throw new Error("Model receipt smoke requires an explicit agent turn.");
  if (agentFollowUp && modelReceipt) throw new Error("Run model-receipt and agent-follow-up smokes separately; the receipt covers only the first turn.");
  if (modelReceipt) checkedModelReceipt(modelReceipt);
  if (!token || !otherToken || token === otherToken) throw new Error("Set distinct APP_API_TOKEN and APP_API_OTHER_TOKEN with record read/write access for different owners.");
  const checkedAccounts = accountBrowser ? checkedBrowserAccounts(browserAccounts) : undefined;
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const protection = bypass ? { "x-vercel-protection-bypass": bypass } : {};
  const authorized = { authorization: `Bearer ${token}` };
  const other = { authorization: `Bearer ${otherToken}` };
  const rawRequest = (path, options = {}) => {
    const { headers, timeoutMs = 15_000, ...rest } = options;
    return fetch(new URL(path, origin), {
      redirect: "error", signal: AbortSignal.timeout(timeoutMs), ...rest,
      headers: { ...protection, ...headers },
    });
  };
  const verifyContract = contract ? await checkDeployedOpenApi(rawRequest) : null;
  const request = async (path, options = {}) => {
    const response = await rawRequest(path, options);
    if (verifyContract) await verifyContract(path, options.method ?? "GET", response);
    return response;
  };
  if (checkedAccounts) await verifyBrowserAccounts(checkedAccounts,token,otherToken,request);
  const live = await request("/api/health/live");
  assert.equal(live.status, 200, "Web liveness failed");
  const ready = await request("/api/health/ready");
  assert.equal(ready.status, 200, "Application data readiness failed");
  const checks = await ready.json();
  assert.equal(checks.status, "ready");
  assert.equal(checks.checks?.data, "ok");
  const agentHealth = await request("/eve/v1/health");
  assert.equal(agentHealth.status, 200, "Eve health failed");
  assert.equal((await agentHealth.json()).status, "ready");
  const page = await request("/records");
  assert.equal(page.status, 200, "Records page failed");
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal((await request("/api/v1/records")).status, 401, "Anonymous record access must be denied");
  if (accounts) {
    // Usage is a registered-user-only route. This proves the deployment accepts
    // both Supabase identities and has account chat configured without a model call.
    for (const headers of [authorized, other]) {
      const usage = await request("/api/v1/usage", { headers });
      assert.equal(usage.status, 200, "Supabase account usage access failed");
      assert.ok((await usage.json()).dailyLimitMicros > 0, "Account budget policy is unavailable");
    }
  }
  if (requestLimit) await runRequestLimitSmoke({ request,origin,token,authorized,other,protection });

  const creationKey = randomUUID(), title = `Hosted smoke ${randomUUID()}`;
  const recordInput = { title, content: "Portable REST, CLI and MCP acceptance check." };
  const creationPath = `/api/v1/records/creation/${creationKey}`;
  console.log(`Temporary record: ${title}`);
  let record, client, failure, cleanupFailure, uploadId;
  try {
    const created = await request("/api/v1/records", {
      method: "POST", headers: { ...authorized, "content-type": "application/json", "idempotency-key": creationKey },
      body: JSON.stringify(recordInput),
    });
    assert.equal(created.status, 201, "Record creation failed");
    record = await created.json();
    assert.equal(record.title, title);
    assert.match(record.id, /^[0-9a-f-]{36}$/i);
    assert.equal(created.headers.get("location"), `/api/v1/records/${record.id}`);
    const recovered = await request(creationPath, { headers: authorized });
    assert.equal(recovered.status, 200, "Owner cannot recover keyed record creation");
    assert.deepEqual(await recovered.json(), { status: "created", record });
    assert.equal((await request(creationPath, { headers: other })).status, 404,
      "Other owner can recover keyed record creation");
    const replay = await request("/api/v1/records", {
      method: "POST", headers: { ...authorized, "content-type": "application/json", "idempotency-key": creationKey },
      body: JSON.stringify(recordInput),
    });
    assert.equal(replay.status, 200, "Matching keyed record retry failed");
    assert.equal(replay.headers.get("idempotency-replayed"), "true");
    assert.equal(replay.headers.get("location"), `/api/v1/records/${record.id}`);
    assert.deepEqual(await replay.json(), record);
    const changed = await request("/api/v1/records", {
      method: "POST", headers: { ...authorized, "content-type": "application/json", "idempotency-key": creationKey },
      body: JSON.stringify({ ...recordInput, content: "Changed retry must fail." }),
    });
    assert.equal(changed.status, 409, "Changed keyed record retry was accepted");
    const ownRead = await request(`/api/v1/records/${record.id}`, { headers: authorized });
    assert.equal(ownRead.status, 200);
    assert.deepEqual(await ownRead.json(), record);
    assert.equal((await request(`/api/v1/records/${record.id}`, { headers: other })).status, 404, "Other owner can read the temporary record");
    assert.equal((await request(`/api/v1/records/${record.id}`, {
      method: "PATCH", headers: { ...other, "content-type": "application/json" },
      body: JSON.stringify({ title: "Unauthorized edit", content: record.content, revision: record.revision }),
    })).status, 409, "Other owner can edit the temporary record");
    assert.equal((await request(`/api/v1/records/${record.id}?revision=${record.revision}`, {
      method: "DELETE", headers: other,
    })).status, 409, "Other owner can delete the temporary record");
    const otherList = await request("/api/v1/records?limit=100", { headers: other });
    assert.equal(otherList.status, 200, "Other owner's record list failed");
    assert.ok(!(await otherList.json()).items.some(item => item.id === record.id), "Other owner can list the temporary record");
    assert.deepEqual(await cliJson(origin, token, ["get", record.id]), record);
    assert.deepEqual(await cliJson(origin, token, ["creation", creationKey]), { status: "created", record });
    client = new Client({ name: "hosted-smoke", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), { requestInit: { headers: { ...protection, ...authorized } } }));
    const resource = await client.readResource({ uri: `records:///${record.id}` });
    assert.deepEqual(JSON.parse(resource.contents[0].text), record);
    const mcpStatus = await client.callTool({ name: "records_creation_status", arguments: { creationKey } });
    assert.notEqual(mcpStatus.isError, true, "MCP keyed creation recovery failed");
    assert.deepEqual(JSON.parse(mcpStatus.content[0].text), { status: "created", record });
    const mcpReplay = await client.callTool({ name: "records_create", arguments: { ...recordInput, creationKey } });
    assert.notEqual(mcpReplay.isError, true, "MCP keyed creation replay failed");
    assert.deepEqual(JSON.parse(mcpReplay.content[0].text), record);
    if (uploads || uploadDownload) uploadId = await runUploadSmoke({ request, origin, token, otherToken, protection, authorized, other, ownerClient: client, download: uploadDownload });
    if (browser) await browserRead({ origin, token, otherToken, protection, title });
    if (checkedAccounts) await accountBrowserRead({ origin,protection,accounts: checkedAccounts,title });
  } catch (error) { failure = error; }
  finally {
    try { await client?.close(); } catch (error) { cleanupFailure = error; }
    if (!record) {
      // A timed-out POST may have committed. Recover by its stable key before
      // cleanup; do not resend the write or guess from another owner's data.
      try {
        const recovered = await request(creationPath, { headers: authorized });
        if (recovered.status === 200) {
          const result = await recovered.json();
          if (result.status === "created" && /^[0-9a-f-]{36}$/i.test(result.record?.id) &&
              Number.isSafeInteger(result.record.revision)) record = result.record;
        }
      } catch { /* Retain the original failure and printed unique title. */ }
    }
    if (record) {
      try {
        const deleted = await request(`/api/v1/records/${record.id}?revision=${record.revision}`, { method: "DELETE", headers: authorized });
        assert.equal(deleted.status, 204, "Temporary record cleanup failed");
        const tombstone = await request(creationPath, { headers: authorized });
        assert.equal(tombstone.status, 200, "Deleted keyed record receipt is missing");
        assert.deepEqual(await tombstone.json(), { status: "deleted", id: record.id });
        const staleReplay = await request("/api/v1/records", {
          method: "POST", headers: { ...authorized, "content-type": "application/json", "idempotency-key": creationKey },
          body: JSON.stringify(recordInput),
        });
        assert.equal(staleReplay.status, 410, "Deleted keyed record was recreated");
      } catch (error) { cleanupFailure = error; }
    }
  }
  if (failure && cleanupFailure) throw new Error(`${message(failure)}; cleanup: ${message(cleanupFailure)}`);
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  const agentResult = agent ? await runAgentSmoke({ origin, token, otherToken, protection, request,modelReceipt,followUp: agentFollowUp }) : undefined;
  if (checkedAccounts && agentResult) await accountBrowserRead({ origin,protection,accounts: checkedAccounts,operationId: agentResult.operationId,
    prompt: agentResult.prompt,followUpPrompt: agentResult.followUpPrompt,followUpMarker: agentResult.followUpMarker });
  return { origin, recordId: record.id, uploadId, agent: agentResult, browser,accountBrowser,requestLimit,contract };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = new Set(args);
  if (flags.size !== args.length || args.some(arg => !["--accounts", "--agent", "--agent-follow-up", "--model-receipt", "--browser","--account-browser","--request-limit","--uploads","--upload-download","--contract"].includes(arg))) {
    console.error("Supported options: --accounts (budget access, no model call), --agent (one owned model turn), --agent-follow-up (second owned turn in the same session; use with --agent), --model-receipt (exact model and settled nonzero cost for the first turn), --browser (token records UI), --account-browser (real sign-in, reload, logout and account isolation), --request-limit (active registered-owner admission across REST/CLI/MCP), --uploads (private upload isolation and cleanup), --upload-download (also require fresh-scanned exact bytes), --contract (exact deployed OpenAPI revision and successful REST response schemas).");
    process.exitCode = 2;
  } else {
    const agent = flags.has("--agent"),agentFollowUp = flags.has("--agent-follow-up"),accountBrowser = flags.has("--account-browser"),accounts = agent || flags.has("--accounts"), browser = flags.has("--browser"),requestLimit = flags.has("--request-limit"),uploadDownload = flags.has("--upload-download"),uploads = flags.has("--uploads") || uploadDownload,contract = flags.has("--contract"),modelReceipt = flags.has("--model-receipt")
      ? { expectedModel: process.env.APP_SMOKE_EXPECTED_MODEL,maxObservedMicros: Number(process.env.APP_SMOKE_MAX_OBSERVED_MICROS) } : undefined;
    runHostedSmoke({ url: process.env.APP_API_URL, token: process.env.APP_API_TOKEN, otherToken: process.env.APP_API_OTHER_TOKEN, target: process.env.APP_SMOKE_TARGET, accounts, agent,agentFollowUp,browser,accountBrowser,requestLimit,uploads,uploadDownload,contract,modelReceipt,
      browserAccounts: accountBrowser ? { primary: { email: process.env.APP_SMOKE_EMAIL,password: process.env.APP_SMOKE_PASSWORD },other: { email: process.env.APP_SMOKE_OTHER_EMAIL,password: process.env.APP_SMOKE_OTHER_PASSWORD } } : undefined })
      .then(({ origin }) => console.log(`Hosted smoke passed for ${origin}: readiness, Eve, web, ${accounts ? "Supabase accounts, " : ""}REST, keyed creation recovery/deletion, owner isolation, CLI and MCP${contract ? ", exact OpenAPI revision and REST response schemas" : ""}${requestLimit ? ", active owner request admission" : ""}${uploads ? ", private upload and cleanup" : ""}${uploadDownload ? ", fresh-scanned exact download bytes" : ""}${browser ? ", Chromium records UI" : ""}${agent ? ", one owned agent turn and source-stream read" : ""}${agentFollowUp ? ", second owned turn and projected context recall" : ""}${modelReceipt ? ", exact model and settled cost receipt" : ""}${accountBrowser ? ", real account sign-in/reload/logout and browser isolation" : ""}.`))
      .catch(error => { console.error(message(error)); process.exitCode = 1; });
  }
}
