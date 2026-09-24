import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "jumpstart-convex-"));
const cli = join(root, "node_modules/convex/bin/main.js");
const secret = randomBytes(32).toString("base64url");
const env = { ...process.env, CONVEX_AGENT_MODE: "anonymous" };
// This harness must never inherit a real deployment or authentication context.
for (const name of ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY"]) delete env[name];
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const cloudPort = await freePort();
let sitePort = await freePort();
while (cloudPort === sitePort) sitePort = await freePort();
const siteUrl = `http://127.0.0.1:${sitePort}`;
let backend, activeChild, terminated = false, startupError;
let output = "";
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { terminated = true; activeChild?.kill(signal); backend?.kill(signal); });
async function command(args, options = {}) {
  let diagnostic = "";
  activeChild = spawn(process.execPath, args, { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"], ...options });
  if (options.input) activeChild.stdin.end(options.input); else activeChild.stdin.end();
  activeChild.stdout.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); if (options.log) process.stdout.write(chunk); });
  activeChild.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); if (options.log) process.stderr.write(chunk); });
  const [code, signal] = await once(activeChild, "exit"); activeChild = undefined;
  if (code !== 0 || signal) throw new Error(`Convex test command failed (${signal ?? code}). ${diagnostic.replaceAll(secret,"[redacted]")}`);
}
try {
  await cp(join(root, "convex"), join(directory, "convex"), { recursive: true });
  await cp(join(root, "convex.json"), join(directory, "convex.json"));
  await mkdir(join(directory, "lib/data"), { recursive: true });
  await cp(join(root, "lib/data/contract.ts"), join(directory, "lib/data/contract.ts"));
  await mkdir(join(directory, "lib/agent-access"), { recursive: true });
  await cp(join(root, "lib/agent-access/contract.ts"), join(directory, "lib/agent-access/contract.ts"));
  await cp(join(root, "lib/agent-access/projection-contract.ts"), join(directory, "lib/agent-access/projection-contract.ts"));
  await cp(join(root, "lib/agent-access/artifact-contract.ts"), join(directory, "lib/agent-access/artifact-contract.ts"));
  await mkdir(join(directory, "lib/budgets"), { recursive: true });
  await cp(join(root, "lib/budgets/contract.ts"), join(directory, "lib/budgets/contract.ts"));
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "jumpstart-convex-contract-fixture", private: true, type: "module", dependencies: { convex: packageJson.dependencies.convex } }));
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  // Port flags are supported by the pinned CLI. Temporary cwd and anonymous
  // mode isolate this backend from an operator's configured cloud deployment.
  backend = spawn(process.execPath, [cli, "dev", "--local-cloud-port", String(cloudPort), "--local-site-port", String(sitePort), "--tail-logs", "disable"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  const capture = chunk => { output = (output + chunk.toString()).slice(-16_000); };
  backend.stdout.on("data", capture); backend.stderr.on("data", capture);
  backend.on("error", error => { startupError = error; });
  const deadline = Date.now() + 120_000;
  while (!output.includes("Convex functions ready")) {
    if (output.includes("Found ") && output.includes("error") && output.includes("TypeScript typecheck")) throw new Error("Local Convex TypeScript validation failed.");
    if (terminated || startupError || backend.exitCode !== null || backend.signalCode !== null) throw new Error("Local Convex backend stopped before becoming ready.");
    if (Date.now() > deadline) throw new Error("Local Convex startup exceeded 120 seconds.");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  // Opt-in regeneration uses the disposable deployment, never operator credentials.
  if (process.argv.includes("--update-codegen")) await cp(join(directory, "convex/_generated"), join(root, "convex/_generated"), { recursive: true });
  await command([cli, "env", "set", "CONVEX_BACKEND_SECRET"], { input: secret });
  const ready = await fetch(`${siteUrl}/app/records`, { method: "POST", headers: { "content-type": "application/json", "x-jumpstart-backend-key": secret }, body: JSON.stringify({ operation: "health" }), signal: AbortSignal.timeout(5000) });
  if (!ready.ok) throw new Error(`Local Convex readiness failed (${ready.status}).`);
  // Real deployment boundary: anonymous clients must not bypass the HTTP action
  // by naming an internal function through the public Convex query endpoint.
  const direct = await fetch(`http://127.0.0.1:${cloudPort}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "records:health", args: {}, format: "json" }), signal: AbortSignal.timeout(5000) });
  const directResult = await direct.json();
  if (direct.ok && directResult.status !== "error") throw new Error("Internal Convex query was publicly accessible.");
  const accessDirect = await fetch(`http://127.0.0.1:${cloudPort}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "access:ownsSession", args: { tenant: "victim", subject: "victim", sessionId: "session" }, format: "json" }), signal: AbortSignal.timeout(5000) });
  const accessResult = await accessDirect.json();
  if (accessDirect.ok && accessResult.status !== "error") throw new Error("Internal session access query was publicly accessible.");
  await command([join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts"], {
    cwd: root, env: { ...env, DATA_PROVIDER: "convex", CONVEX_SITE_URL: siteUrl, CONVEX_BACKEND_SECRET: secret }, log: true,
  });
  console.log("Local Convex: real backend contract and internal-function isolation passed.");
} catch (error) {
  // Only the local dev service output is included; key-setting commands are not logged.
  console.error(error instanceof Error ? error.message : "Convex validation failed.");
  console.error(output);
  process.exitCode = 1;
} finally {
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    const exited = once(backend, "exit");
    backend.kill("SIGTERM");
    const timeout = setTimeout(() => backend.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timeout);
  }
  await rm(directory, { recursive: true, force: true });
}
