import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SignJWT } from "jose";
import { startChatFixture } from "./helpers/eve-chat-fixture.mjs";

// Real isolated Supabase Auth, PostgreSQL and SMTP delivery. No hosted account.
const name = `jumpstart-auth-${randomBytes(5).toString("hex")}`;
const directory = await mkdtemp(join(tmpdir(), `${name}-`));
const password = randomBytes(24).toString("base64url");
const jwtSecret = randomBytes(32).toString("base64url");
const containers = [];
const chat = process.argv.includes("--chat");
const containerMode = process.argv.includes("--container");
if (containerMode && !chat) throw new Error("Container mode requires --chat.");
const image = process.env.TEST_CONTAINER_IMAGE ?? "ai-app-jumpstart:test";
let web, proxy, runtime, imageManifest, failed = false, webOutput = "";
async function command(executable, args, options = {}) {
  const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  let output = "";
  child.stdout?.on("data", chunk => { output = (output + chunk).slice(-12000); });
  child.stderr?.on("data", chunk => { output = (output + chunk).slice(-12000); });
  const [code, signal] = await once(child, "exit");
  if (code !== 0 || signal) throw new Error(`${executable} failed (${signal ?? code}): ${output.replaceAll(jwtSecret, "[redacted]").replaceAll(password, "[redacted]")}`);
  return output.trim();
}
const docker = (...args) => command("docker", args);
async function runContainer(suffix, image, vars, extra = [], args = []) {
  const container = `${name}-${suffix}`; containers.push(container);
  const file = join(directory, `${suffix}.env`);
  await writeFile(file, Object.entries(vars).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
  await docker("run", "--detach", "--name", container, "--network", name, "--network-alias", suffix, "--env-file", file, ...extra, image, ...args);
  return container;
}
const portOf = async (container, port) => (await docker("port", container, `${port}/tcp`)).split(":").at(-1);
async function waitFor(check, label, alive) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (alive && !await alive()) throw new Error(`${label} stopped before becoming ready.`);
    if (await check().catch(() => false)) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`${label} did not become ready.`);
}
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const webPort = await freePort();
const appOrigin = `http://127.0.0.1:${webPort}`;
try {
  if (containerMode) {
    await docker("image", "inspect", image);
    // The image is the source of truth for build-time Eve rewrites; CI has no
    // host .next build when this suite follows the container runtime test.
    imageManifest = JSON.parse(await docker("run", "--rm", "--entrypoint", "cat", image, "/app/.next/routes-manifest.json"));
  }
  await docker("network", "create", name);
  await runContainer("postgres", "postgres:17-bookworm", { POSTGRES_PASSWORD: password, POSTGRES_USER: "auth_test", POSTGRES_DB: "auth_test" });
  // TCP readiness excludes the image's temporary socket-only bootstrap server.
  await waitFor(async () => (await docker("exec", `${name}-postgres`, "pg_isready", "-h", "127.0.0.1", "-U", "auth_test", "-d", "auth_test")).includes("accepting"), "PostgreSQL", async () => {
    if (await docker("inspect", "--format", "{{.State.Running}}", `${name}-postgres`) === "true") return true;
    const logs = await docker("logs", "--tail", "12", `${name}-postgres`);
    throw new Error(`PostgreSQL startup failed: ${logs.replaceAll(password,"[redacted]").slice(-1200)}`);
  });
  await docker("exec", `${name}-postgres`, "psql", "-U", "auth_test", "-d", "auth_test", "-v", "ON_ERROR_STOP=1", "-c", "CREATE ROLE postgres NOLOGIN; CREATE SCHEMA auth AUTHORIZATION auth_test; ALTER ROLE auth_test SET search_path = auth, public;");
  const mail = await runContainer("mail", "axllent/mailpit:v1.31.2", {}, ["--publish", "127.0.0.1::8025"]);
  const mailOrigin = `http://127.0.0.1:${await portOf(mail, 8025)}`;
  let authOrigin;
  proxy = createServer(async (req, res) => {
    // The real Auth service handles credentials. This fixture only supplies the
    // gateway prefix and CORS normally provided by Supabase's API gateway.
    res.setHeader("access-control-allow-origin", appOrigin);
    res.setHeader("access-control-allow-headers", "authorization,apikey,content-type,x-client-info,x-supabase-api-version");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
    if (!req.url?.startsWith("/auth/v1/")) { res.writeHead(404).end(); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value && !["host", "connection", "content-length"].includes(key)) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      const upstream = await fetch(`${authOrigin}${req.url.slice("/auth/v1".length)}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      upstream.headers.forEach((value, key) => { if (!["content-encoding", "content-length", "transfer-encoding", "access-control-allow-origin"].includes(key)) res.setHeader(key, value); });
      res.writeHead(upstream.status).end(Buffer.from(await upstream.arrayBuffer()));
    } catch { res.writeHead(502).end(); }
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const publicAuthOrigin = `http://127.0.0.1:${proxy.address().port}`;
  const auth = await runContainer("auth", "supabase/gotrue:v2.197.0", {
    GOTRUE_API_HOST: "0.0.0.0", PORT: "9999", GOTRUE_DB_DRIVER: "postgres", DB_NAMESPACE: "auth",
    DATABASE_URL: `postgres://auth_test:${password}@postgres:5432/auth_test`,
    API_EXTERNAL_URL: `${publicAuthOrigin}/auth/v1`, GOTRUE_SITE_URL: appOrigin, GOTRUE_URI_ALLOW_LIST: `${appOrigin}/**`,
    GOTRUE_JWT_SECRET: jwtSecret, GOTRUE_JWT_EXP: "3600", GOTRUE_JWT_AUD: "authenticated", GOTRUE_JWT_ADMIN_ROLES: "service_role", GOTRUE_JWT_DEFAULT_GROUP_NAME: "authenticated",
    GOTRUE_EXTERNAL_EMAIL_ENABLED: "true", GOTRUE_DISABLE_SIGNUP: "false", GOTRUE_MAILER_AUTOCONFIRM: "false", GOTRUE_PASSWORD_MIN_LENGTH: "12",
    GOTRUE_SMTP_HOST: "mail", GOTRUE_SMTP_PORT: "1025", GOTRUE_SMTP_ADMIN_EMAIL: "noreply@example.test", GOTRUE_SMTP_SENDER_NAME: "Jumpstart test", GOTRUE_SMTP_MAX_FREQUENCY: "1s",
    GOTRUE_RATE_LIMIT_EMAIL_SENT: "100", GOTRUE_MAILER_URLPATHS_CONFIRMATION: "/auth/v1/verify", GOTRUE_MAILER_URLPATHS_RECOVERY: "/auth/v1/verify",
  }, ["--publish", "127.0.0.1::9999"]);
  authOrigin = `http://127.0.0.1:${await portOf(auth, 9999)}`;
  await waitFor(async () => (await fetch(`${authOrigin}/health`)).ok, "Supabase Auth", async () => {
    if (await docker("inspect", "--format", "{{.State.Running}}", auth) === "true") return true;
    // Startup diagnostics only, before any users or verification links exist.
    const logs = await docker("logs", "--tail", "6", auth);
    const fatal = logs.split("\n").flatMap(line => { try { const item = JSON.parse(line); return item.level === "fatal" ? [String(item.msg).slice(-900)] : []; } catch { return []; } }).join("\n");
    throw new Error(`Supabase Auth startup failed: ${fatal.replaceAll(password, "[redacted]").replaceAll(jwtSecret, "[redacted]")}`);
  });
  const key = new TextEncoder().encode(jwtSecret);
  const anon = await new SignJWT({ role: "anon" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(key);
  const admin = await new SignJWT({ role: "service_role" }).setProtectedHeader({ alg: "HS256" }).setIssuedAt().setExpirationTime("1h").sign(key);
  const env = { ...process.env, NODE_ENV: "production", AUTH_PROVIDER: "supabase", SUPABASE_AUTH_URL: publicAuthOrigin, SUPABASE_PUBLISHABLE_KEY: anon, APP_API_KEYS: "[]", APP_ORIGIN: appOrigin, DATA_PROVIDER: "sqlite", SQLITE_PATH: join(directory, "records.sqlite"), UPLOAD_STORAGE_PROVIDER: "local", UPLOAD_LOCAL_ROOT: join(directory, "uploads") };
  env.AI_CHAT_ENABLED = chat ? "true" : "false";
  if (chat) {
    env.AI_CREATION_SIGNING_JSON = JSON.stringify({ audience: name, activeKey: "fixture", keys: { fixture: randomBytes(32).toString("hex") } });
    env.AI_BUDGET_POLICY_JSON = JSON.stringify({ policy: { id: "fixture", dailyMicros: 60, maxActive: 2, maxPerMinute: 20 }, estimateMicros: 20, maxModelCalls: 2, modelIds: ["model", "eve-mock/model"],
      costBasis: { sourceUrl: "https://example.test/fixture-prices", reviewedAt: "2026-09-24", maxOtherMicros: 0,
        models: ["model", "eve-mock/model"].map(id => ({ id, maxInputTokens: 1, maxOutputTokens: 1, inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 })) } });
    runtime = await startChatFixture(process.cwd(), directory, env, { buildOnly: containerMode, routesManifest: imageManifest });
    env.AI_RUNTIME_ORIGIN = runtime.origin;
  }
  if (containerMode) {
    const containerEnv = {
      NODE_ENV: "production", AUTH_PROVIDER: "supabase", SUPABASE_AUTH_URL: publicAuthOrigin,
      SUPABASE_PUBLISHABLE_KEY: anon, APP_API_KEYS: "[]", APP_ORIGIN: appOrigin,
      DATA_PROVIDER: "sqlite", SQLITE_PATH: "/app/.data/records.sqlite", AI_CHAT_ENABLED: "true",
      UPLOAD_STORAGE_PROVIDER: "local", UPLOAD_LOCAL_ROOT: "/app/.data/uploads",
      AI_CREATION_SIGNING_JSON: env.AI_CREATION_SIGNING_JSON,
      AI_BUDGET_POLICY_JSON: env.AI_BUDGET_POLICY_JSON,
      AI_RUNTIME_ORIGIN: "http://127.0.0.1:4274", WORKFLOW_TARGET_WORLD: "local",
      WORKFLOW_LOCAL_DATA_DIR: "/app/.eve/.workflow-data", WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:4274",
      TEST_MODEL_RECEIPTS: "/app/.data/models.txt", TEST_FAILURE_RECEIPTS: "/app/.data/failures.txt",
      TEST_RECEIPT_GATE: "/app/.data/gate", EVE_TELEMETRY_DISABLED: "1",
    };
    const app = await runContainer("app", image, containerEnv, ["--init", "--publish", `127.0.0.1:${webPort}:3000`, "--entrypoint", "sleep"], ["600"]);
    await docker("exec", app, "find", "/app/.output", "-mindepth", "1", "-delete");
    await docker("cp", `${runtime.output}/.`, `${app}:/app/.output/`);
    await docker("exec", app, "sh", "-c", "printf ready > /app/.data/gate");
    // The browser and server use one loopback Auth URL. Inside the app's network
    // namespace, forward that port to the real GoTrue service on this test network.
    const authPort = String(new URL(publicAuthOrigin).port);
    const forward = `import http from "node:http"; http.createServer((request,response) => { const upstream = http.request({ hostname: "auth", port: 9999, method: request.method, path: request.url.replace(/^\\/auth\\/v1(?=\\/|$)/, "") || "/", headers: { ...request.headers, host: "auth:9999" } }, result => { response.writeHead(result.statusCode ?? 502, result.headers); result.pipe(response); }); upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); }); request.pipe(upstream); }).listen(Number(process.env.TEST_AUTH_FORWARD_PORT), "127.0.0.1");`;
    await docker("exec", "--detach", "--env", `TEST_AUTH_FORWARD_PORT=${authPort}`, app, "node", "--input-type=module", "-e", forward);
    await waitFor(async () => (await docker("exec", app, "node", "-e", `fetch("http://127.0.0.1:${authPort}/auth/v1/health").then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))`)) === "", "Container Auth forwarder");
    web = spawn("docker", ["exec", "--user", "node", app, "node", "scripts/start-local.mjs"], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  } else {
    // Run the compiled web service directly. Chat mode uses the temporary Eve
    // fixture above; neither mode opens the operator's local Workflow directory.
    web = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(webPort)], { env, stdio: ["ignore", "pipe", "pipe"] });
  }
  const capture = chunk => { webOutput = (webOutput + chunk).slice(-10000); }; web.stdout.on("data", capture); web.stderr.on("data", capture);
  await waitFor(async () => {
    return (await fetch(`${appOrigin}/api/health/live`, { signal: AbortSignal.timeout(1000) })).ok;
  }, "Production application", async () => web.exitCode === null && web.signalCode === null);
  await command(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", "playwright.auth.config.ts", ...process.argv.slice(2).filter(arg => arg !== "--chat" && arg !== "--container")], { env: { ...env, TEST_CHAT: chat ? "1" : "", TEST_AUTH_ORIGIN: publicAuthOrigin, TEST_AUTH_ADMIN_KEY: admin, TEST_MAIL_ORIGIN: mailOrigin,
    TEST_RECEIPT_GATE_HOST: chat ? join(directory, "gate") : "", TEST_MODEL_RECEIPTS_HOST: chat ? join(directory, "models.txt") : "",
    TEST_FAILURE_RECEIPTS_HOST: chat ? join(directory, "failures.txt") : "", TEST_CHAT_CONTAINER: containerMode ? `${name}-app` : "" }, stdio: "inherit" });
  console.log(containerMode ? "Account chat browser contract passed through the production container." : chat ? "Account chat browser contract passed with real Auth and compiled Eve." : "Real Supabase Auth browser contract passed.");
} catch (error) {
  failed = true;
  console.error(error instanceof Error ? error.message : "Auth integration failed.");
  console.error(webOutput);
  // Only SQL diagnostics, never raw request logs or verification links.
  const logs = await docker("logs", "--tail", "100", `${name}-auth`).catch(() => "");
  for (const line of logs.split("\n")) {
    try {
      const item = JSON.parse(line);
      if (typeof item.error === "string" && item.error.includes("SQLSTATE")) console.error(item.error.slice(-1000).replaceAll(password, "[redacted]").replaceAll(jwtSecret, "[redacted]"));
    } catch { /* Non-JSON container diagnostics are omitted. */ }
  }
} finally {
  if (containerMode) await docker("rm", "--force", `${name}-app`).catch(() => {});
  if (web && web.exitCode === null && web.signalCode === null) {
    const exited = once(web, "exit"); web.kill("SIGTERM");
    const timer = setTimeout(() => web.kill("SIGKILL"), 25_000); await exited; clearTimeout(timer);
  }
  proxy?.closeAllConnections(); if (proxy) await new Promise(resolve => proxy.close(resolve));
  await runtime?.stop();
  for (const container of containers.reverse()) await docker("rm", "--force", "--volumes", container).catch(() => {});
  await docker("network", "rm", name).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
