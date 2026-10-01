import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
if (existsSync(join(root, ".env.local"))) throw new Error("Remove .env.local before checking the credential-free Vercel build.");

// Do not let a maintainer's deployment settings make this structural build pass.
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (/^(?:APP_|SUPABASE_|DATABASE_URL$|DATA_PROVIDER$|AUTH_PROVIDER$|AI_|EVE_|WORKFLOW_|OPENAI_|ANTHROPIC_|CONVEX_|CRON_SECRET$|UPLOAD_|VERCEL_|NEXT_PUBLIC_)/.test(name)) delete env[name];
}
env.VERCEL = "1";
env.NEXT_TELEMETRY_DISABLED = "1";

async function command(program, args, cwd) {
  const child = spawn(program, args, { cwd, env, stdio: "inherit" });
  const code = await new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", accept);
  });
  if (code !== 0) throw new Error(`${program} build exited with ${code ?? "a signal"}.`);
}
async function json(path) { return JSON.parse(await readFile(path, "utf8")); }

const hostOutput = join(root, ".vercel/output");
const serviceRoot = join(root, ".eve/vercel-services/eve");
const serviceOutput = join(serviceRoot, ".vercel/output");
await rm(hostOutput, { recursive: true, force: true });
await rm(serviceOutput, { recursive: true, force: true });

const deployment = await json(join(root,"vercel.json"));
assert.deepEqual(deployment.crons,[{ path: "/api/internal/uploads/cleanup",schedule: "0 2 * * *" }],
  "The managed deployment must schedule one daily upload cleanup pass.");

await command("npm", ["run", "build"], root);
const host = await json(join(hostOutput, "config.json"));
assert.equal(host.version, 3);
assert.deepEqual(Object.keys(host.services ?? {}), ["eve"], "Next must publish exactly one Eve service.");
const service = host.services.eve;
assert.equal(service.framework, "eve");
assert.equal(resolve(root, service.root), serviceRoot);
assert.ok(typeof service.buildCommand === "string" && service.buildCommand.length > 0);
assert.ok(host.routes?.some(route => route.destination?.type === "service" && route.destination.service === "eve" &&
  new RegExp(route.src).test("/eve/v1/health")), "The public Eve route must reach its generated service.");

// Run the exact command emitted for Vercel's service builder, from its root.
await command("sh", ["-c", service.buildCommand], serviceRoot);
const built = await json(join(serviceOutput, "config.json"));
assert.equal(built.version, 3);
assert.ok(built.routes?.some(route => route.src === "/eve/v1/health"), "The service must expose Eve health.");
assert.ok(built.routes?.some(route => route.src === "/.well-known/workflow/v1/flow"), "The service must expose Workflow callbacks.");
const functionConfig = await json(join(serviceOutput, "functions/__server.func/.vc-config.json"));
assert.equal(functionConfig.runtime, "nodejs24.x");
assert.equal(functionConfig.supportsResponseStreaming, true);
assert.ok(existsSync(join(serviceOutput, "functions/__server.func/index.mjs")));
console.log("Local Vercel graph passed: Next route, built Eve service, Workflow callback and streaming Node 24 function.");
