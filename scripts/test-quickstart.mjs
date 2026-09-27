import assert from "node:assert/strict";
import { processManager } from "./helpers/quickstart-process.mjs";
import { cloneCommittedCheckout } from "./helpers/quickstart-checkout.mjs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Rehearse committed HEAD, never copy the developer's working files or env.
const root = fileURLToPath(new URL("../", import.meta.url));
const env = Object.fromEntries(["PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "PLAYWRIGHT_BROWSERS_PATH"]
  .filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { CI: "true", NEXT_TELEMETRY_DISABLED: "1", NO_COLOR: "1" });
const secrets = [];
let directory, server, stage = "preflight", interrupted = false;
const redact = text => secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), String(text));
function phase(value) { stage = value; console.log(`Quickstart: ${stage}...`); }

const manager = processManager({ cwd: root, env, secrets });
const launch = (...args) => {
  if (interrupted) throw new Error("Rehearsal interrupted.");
  return manager.launch(...args);
};
const command = (...args) => launch(...args).result();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  interrupted = true;
  void manager.stopAll().catch(() => {});
});

async function freePort(excluded = new Set()) {
  while (true) {
    const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
    const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
    if (!excluded.has(port)) return port;
  }
}
async function ready(origin) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null || server.child.signalCode !== null) throw new Error("Production supervisor stopped before readiness.");
    const response = await fetch(`${origin}/api/health/ready`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (response?.ok) {
      assert.deepEqual(await response.json(), { status: "ready", checks: { data: "ok", agent: "ok" } }); return;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error("Fresh-clone services did not become ready.");
}

try {
  if (process.argv.length !== 2) throw new Error("This command takes no arguments and tests committed HEAD.");
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("The process-group rehearsal requires macOS or Linux.");
  directory = await mkdtemp(join(tmpdir(), "jumpstart-quickstart-"));
  const { checkout,revision } = await cloneCommittedCheckout({ root,directory,env,command,phase });
  console.log(`Rehearsing fresh commit ${revision.slice(0, 7)} with isolated SQLite and no provider credentials...`);
  phase("documented configuration");
  const credentials = [];
  for (const subject of ["developer", "other-developer"]) {
    const output = await command("npm", ["run", "--silent", "auth:key", "--", "local", subject, "write"], { cwd: checkout, privateOutput: true });
    let key;
    try { key = JSON.parse(output); } catch { throw new Error("Key generator returned invalid JSON; private output omitted."); }
    if (typeof key?.token !== "string" || !/^[A-Za-z0-9_-]{40,128}$/.test(key.token)) throw new Error("Key generator returned an invalid credential; private output omitted.");
    secrets.push(key.token); credentials.push(key);
    assert.equal(key.configuration.length, 1);
    assert.deepEqual(key.configuration[0].scopes, ["records:read", "records:write"]);
  }
  const port = await freePort(), agentPort = await freePort(new Set([port]));
  const origin = `http://127.0.0.1:${port}`;
  const example = await readFile(join(checkout, ".env.example"), "utf8");
  for (const setting of ["DATA_PROVIDER=sqlite", "AUTH_PROVIDER=api-key", "AI_CHAT_ENABLED=false", "SQLITE_PATH=.data/app.sqlite", "APP_API_KEYS=[]"]) {
    assert.ok(example.split("\n").includes(setting), `Documented SQLite default changed: ${setting}`);
  }
  const configuration = example.replace(/^APP_ORIGIN=.*$/m, `APP_ORIGIN=${origin}`)
    .replace(/^APP_API_KEYS=.*$/m, `APP_API_KEYS='${JSON.stringify(credentials.flatMap(key => key.configuration))}'`);
  await writeFile(join(checkout, ".env.local"), configuration, { mode: 0o600, flag: "wx" });
  const localEnv = { ...env, EVE_NEXT_PRODUCTION_PORT: String(agentPort) };
  phase("types, lint and tests");
  await command("npm", ["run", "check"], { cwd: checkout, env: localEnv });
  phase("production build");
  await command("npm", ["run", "build:local"], { cwd: checkout, env: localEnv });
  const manifest = JSON.parse(await readFile(join(checkout, "package.json"), "utf8"));
  assert.equal(manifest.scripts.start, "node scripts/start-local.mjs", "Rehearsal must match npm start's supervisor.");
  const start = () => launch(process.execPath, ["scripts/start-local.mjs", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: checkout, env: localEnv, timeout: 180_000,
  });
  phase("production startup and repeatable seed");
  server = start(); await ready(origin);
  const clientEnv = { ...localEnv, APP_API_URL: origin, APP_API_TOKEN: credentials[0].token, APP_API_OTHER_TOKEN: credentials[1].token };
  const seed = async () => JSON.parse(await command("npm", ["run", "--silent", "seed:records"], { cwd: checkout, env: clientEnv }));
  assert.deepEqual(await seed(), { created: 2, existing: 0, titles: JSON.parse(await readFile(join(checkout, "scripts/fixtures/records.json"), "utf8")).map(row => row.title) });
  const rerun = await seed(); assert.equal(rerun.created, 0); assert.equal(rerun.existing, 2);
  const list = async () => {
    const response = await fetch(`${origin}/api/v1/records`, { headers: { authorization: `Bearer ${credentials[0].token}` }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); return response.json();
  };
  const before = await list(); assert.equal(before.items.length, 2);
  phase("restart persistence");
  await server.stop(); server = start(); await ready(origin);
  assert.deepEqual(await list(), before); assert.equal((await seed()).created, 0);
  phase("two-owner browser, REST, CLI and MCP");
  await command("npm", ["run", "smoke:hosted", "--", "--browser"], { cwd: checkout, env: clientEnv });
  phase("closed production runtime");
  assert.equal((await fetch(`${origin}/api/v1/conversations`, { method: "POST", headers: { authorization: `Bearer ${credentials[0].token}`, "content-type": "application/json", origin }, body: "{}", signal: AbortSignal.timeout(5000) })).status, 503);
  await server.stop(); server = undefined;
  phase("deterministic AI evals");
  await command("npm", ["run", "test:ai"], { cwd: checkout, env });
  phase("tracked source remains unchanged");
  assert.equal(await command("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: checkout }), "");
  console.log(`Quickstart passed at ${revision.slice(0, 7)}: clean pinned install/check/build, two services, seed/rerun, restart persistence, two-owner browser/REST/CLI/MCP and deterministic AI evals. No paid turn or hosted deployment.`);
} catch (error) {
  console.error(`Quickstart failed during ${stage}: ${redact(error instanceof Error ? error.message : "unknown error")}`);
  process.exitCode = 1;
} finally {
  await manager.stopAll();
  if (directory) await rm(directory, { recursive: true, force: true });
}
