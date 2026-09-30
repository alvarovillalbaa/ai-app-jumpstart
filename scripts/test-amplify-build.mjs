import assert from "node:assert/strict";
import EmbeddedPostgres from "embedded-postgres";
import { Client as PostgresClient } from "pg";
import { createHash, randomBytes } from "node:crypto";
import { spawn, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { testCommand } from "./helpers/test-command.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "jumpstart-amplify-"));
const children = [];
const password = randomBytes(24).toString("hex");
const cronSecret = randomBytes(32).toString("hex");
const token = "isolated-playwright-token-".repeat(3), otherToken = "isolated-playwright-other-".repeat(3);
let database, diagnostics = "";
const clean = value => [password, token, otherToken, cronSecret].reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function ready(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Local adapter service did not become ready.");
}
function track(child) {
  children.push(child);
  child.stdout?.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
  child.stderr?.on("data", chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
  return child;
}
try {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--skip-build")) throw new Error("Supported option: --skip-build.");
  if (!process.argv.includes("--skip-build")) {
    console.log("Building the actual Amplify adapter and separate Eve worker...");
    await testCommand(process.execPath, ["scripts/build-amplify.mjs"], { cwd: root,
      env: { ...process.env, EVE_NEXT_PRODUCTION_ORIGIN: "https://eve.example.test" }, timeout: 240_000 }, [password, token, otherToken]);
    await testCommand("npm", ["run", "build:eve"], { cwd: root, timeout: 180_000 });
  }
  const manifest = JSON.parse(await readFile(join(root, ".amplify-build/manifest.json"), "utf8"));
  assert.equal(manifest.compute.default.runtime, "nodejs24.x");
  assert.equal(manifest.compute.default.streaming, true);
  assert.equal(manifest.compute.default.handler, "index.handler");
  await testCommand(process.execPath, ["--import", "tsx", "scripts/testing/check-amplify-template.ts"], { cwd: root, timeout: 120_000 });
  const port = await freePort(), pgPort = await freePort(), evePort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  database = new EmbeddedPostgres({ databaseDir: join(directory, "postgres"), user: "adapter", password,
    port: pgPort, persistent: true, authMethod: "scram-sha-256", createPostgresUser: false,
    postgresFlags: ["-h", "127.0.0.1", "-k", directory], onLog() {}, onError() {} });
  await database.initialise(); await database.start(); await database.createDatabase("application");
  const databaseUrl = `postgresql://adapter:${password}@127.0.0.1:${pgPort}/application`;
  await testCommand(process.execPath, ["scripts/migrate.ts"], { cwd: root,
    env: { PATH: process.env.PATH, DATABASE_URL: databaseUrl } }, [password, databaseUrl]);
  const env = { PATH: process.env.PATH, NODE_ENV: "production", APP_ORIGIN: origin,
    DATA_PROVIDER: "postgres", DATABASE_URL: databaseUrl, AUTH_PROVIDER: "api-key", AI_CHAT_ENABLED: "false", CRON_SECRET: cronSecret,APP_REQUESTS_PER_MINUTE: "120",
    APP_API_KEYS: JSON.stringify([token, otherToken].map((value, index) => ({ sha256: createHash("sha256").update(value).digest("hex"),
      tenant: "e2e", subject: index ? "other-browser" : "browser", scopes: ["records:read", "records:write"] }))) };
  track(spawn(process.execPath, [join(root, ".output/server/index.mjs")], { cwd: directory,
    env: { ...env, HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", PORT: String(evePort), NITRO_PORT: String(evePort) }, stdio: ["ignore", "pipe", "pipe"] }));
  await ready(`http://127.0.0.1:${evePort}/eve/v1/health`);
  const bridge = track(fork(join(root, "scripts/testing/amplify-lambda.mjs"), [], { cwd: directory,
    env: { ...env, PORT: String(port), AWS_REGION: "us-east-1", AWS_LAMBDA_FUNCTION_NAME: "local-adapter-fixture",
      TEST_APP_ROOT: root, TEST_EVE_ORIGIN: `http://127.0.0.1:${evePort}` }, stdio: ["ignore", "pipe", "pipe", "ipc"] }));
  await ready(`${origin}/api/health/live`);
  const reservedQuery = await fetch(`${origin}/api/health/live?__proto__=fixture&constructor=fixture`, { signal: AbortSignal.timeout(5000) });
  assert.equal(reservedQuery.status, 200, "Reserved query parameter names must remain ordinary query data");
  const cleanupUrl = `${origin}/api/internal/uploads/cleanup`;
  assert.equal((await fetch(cleanupUrl, { headers: { authorization: `Bearer ${"w".repeat(64)}` }, signal: AbortSignal.timeout(5000) })).status, 401);
  const cleanup = await fetch(cleanupUrl, { headers: { authorization: `Bearer ${cronSecret}` }, signal: AbortSignal.timeout(5000) });
  assert.equal(cleanup.status, 200); assert.deepEqual(await cleanup.json(), { status: "storage_disabled" });
  console.log("Invoking the generated Lambda handler with PostgreSQL and the compiled Eve worker...");
  await testCommand(process.execPath, ["scripts/smoke-hosted.mjs", "--browser", "--contract"], { cwd: root,
    env: { ...process.env, APP_API_URL: origin, APP_API_TOKEN: token, APP_API_OTHER_TOKEN: otherToken }, timeout: 120_000 }, [password, token, otherToken]);
  const configPath = join(root, ".amplify-build/playwright.config.mjs");
  await writeFile(configPath, `export default { testDir: ${JSON.stringify(join(root, "tests/e2e"))}, workers: 1, retries: 0, use: { baseURL: ${JSON.stringify(origin)} }, reporter: 'list' };\n`);
  const browser = await testCommand(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "records.spec.ts", "accessibility.spec.ts", "--config", configPath],
    { cwd: root, env: { ...process.env, APP_SMOKE_UPLOADS: "false" }, timeout: 120_000 }, [password, token, otherToken]);
  console.log(browser.trim().split("\n").at(-1));
  const probe = new PostgresClient({ connectionString: databaseUrl });await probe.connect();
  try {
    const rows = (await probe.query("SELECT subject,counter FROM app_request_limits WHERE tenant='e2e' ORDER BY subject")).rows;
    assert.deepEqual(rows.map(row => row.subject),["browser","other-browser"]);
    assert.ok(rows.every(row => row.counter>0),"Compiled surfaces did not claim their owner quota");
    // A full retained future window also exercises conservative clock rollback.
    assert.equal((await probe.query("UPDATE app_request_limits SET counter=10000,bucket=(floor(extract(epoch FROM clock_timestamp())/60)::bigint+1)*60000 WHERE tenant='e2e' AND subject='browser'")).rowCount,1);
    const before = (await probe.query("SELECT count(*)::int AS count FROM app_records")).rows[0].count;
    const auth = { authorization: `Bearer ${token}`,"content-type": "application/json",origin };
    for (const [path,method,body] of [["/api/v1/records","GET",undefined],
      ["/api/v1/records","POST",JSON.stringify({ title: "Quota must prevent this write",content: "fixture" })],
      ["/api/mcp","POST",JSON.stringify({ jsonrpc: "2.0",id: 1,method: "initialize",params: { protocolVersion: "2025-03-26",capabilities: {},clientInfo: { name: "quota",version: "1" } } })]]) {
      const denied = await fetch(`${origin}${path}`,{ method,body,headers: auth,signal: AbortSignal.timeout(5000) });
      assert.equal(denied.status,429);assert.match(denied.headers.get("retry-after"),/^(?:[1-9]|[1-5][0-9]|60)$/);
      assert.equal((await denied.json()).error.code,"request_limit");
    }
    await assert.rejects(testCommand(process.execPath,["--import","tsx","scripts/app-cli.ts","list"],{ cwd: root,
      env: { ...process.env,APP_API_URL: origin,APP_API_TOKEN: token } },[token]),/HTTP 429: request_limit \(reference:/);
    assert.equal((await fetch(`${origin}/api/v1/records`,{ headers: { authorization: `Bearer ${otherToken}` },signal: AbortSignal.timeout(5000) })).status,200);
    assert.equal((await probe.query("SELECT count(*)::int AS count FROM app_records")).rows[0].count,before);
  } finally { await probe.end(); }
  console.log("Compiled request quotas: shared owner counters, REST/CLI/MCP 429 + Retry-After, no rejected write and independent second owner passed.");
  assert.equal(bridge.exitCode, null);
  console.log("Amplify adapter: actual Node 24 handler, browser hydration/CSP/accessibility, PostgreSQL two-owner REST/CLI/MCP parity and closed compiled Eve operations passed locally.");
} catch (error) {
  console.error(clean(error instanceof Error ? error.message : "Amplify adapter validation failed."));
  if (diagnostics) console.error(clean(diagnostics));
  process.exitCode = 1;
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const ended = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await ended; clearTimeout(timer);
  }
  await database?.stop().catch(() => {}); await rm(directory, { recursive: true, force: true });
}
