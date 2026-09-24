import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { verifyWorkflowBuild } from "./workflow-build-policy.mjs";

// Load local secrets before spawning Eve, not only after Next initializes.
// Explicit process environment values retain precedence.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// Next serves build-time rewrites without evaluating their functions at startup.
// Explicitly supervise both services for the self-hosted production command.
const children = [];
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  await Promise.all(children.map(async child => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    await exited; clearTimeout(timer);
  }));
  process.exitCode = code;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { void stop(0); });
function start(args, env = {}) {
  const child = spawn(process.execPath, args, { stdio: "inherit", env: { ...process.env, NODE_ENV: "production", ...env } });
  children.push(child);
  child.on("error", error => { console.error(error.message); void stop(1); });
  child.on("exit", code => { if (!stopping) void stop(code || 1); });
  return child;
}
try {
  verifyWorkflowBuild();
  let localAgent = false;
  if (!process.env.EVE_NEXT_PRODUCTION_ORIGIN && !process.env.VERCEL) {
    const port = process.env.EVE_NEXT_PRODUCTION_PORT ?? "4274";
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid EVE_NEXT_PRODUCTION_PORT.");
    start([".output/server/index.mjs"], { HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", PORT: port, NITRO_PORT: port });
    const deadline = Date.now() + 60_000;
    let ready = false;
    while (!stopping && Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${port}/eve/v1/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
      if (response?.ok && (await response.json()).status === "ready") { ready = true; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error("Eve did not become ready. Run npm run build:local before starting.");
    localAgent = true;
  }
  if (!stopping) start(["node_modules/next/dist/bin/next", "start", ...process.argv.slice(2)], { APP_AGENT_READINESS: localAgent ? "local" : "external" });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Production startup failed.");
  await stop(1);
}
