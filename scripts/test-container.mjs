import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// Honors DOCKER_CONTEXT/DOCKER_HOST without changing the operator's defaults.
const image = process.env.TEST_CONTAINER_IMAGE ?? "ai-app-jumpstart:test";
const name = `jumpstart-contract-${randomBytes(6).toString("hex")}`;
const volume = `${name}-data`;
const directory = await mkdtemp(join(tmpdir(), "jumpstart-container-"));
const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
const keys = tokens.map((token, index) => ({ sha256: createHash("sha256").update(token).digest("hex"), tenant: "container-test", subject: `user-${index}`, scopes: ["records:read", "records:write"] }));
function command(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => code === 0 ? resolve(output.trim()) : reject(new Error(`${executable} failed (${signal ?? code}): ${output.slice(-6000)}`)));
  });
}
const docker = (...args) => command("docker", args);
async function ready(origin) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/health/ready`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (response?.ok) {
      assert.deepEqual(await response.json(), { status: "ready", checks: { data: "ok", agent: "ok" } });
      return;
    }
    if (await docker("inspect", "--format", "{{.State.Running}}", name) !== "true") throw new Error("Container stopped before readiness.");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Container did not become ready within 90 seconds.");
}
try {
  if (!process.argv.includes("--skip-build")) {
    console.log("Building the production container...");
    await docker("build", "-t", image, ".");
  }
  await writeFile(join(directory, "env"), `APP_API_KEYS=${JSON.stringify(keys)}\nDATA_PROVIDER=sqlite\nSQLITE_PATH=/app/.data/app.sqlite\n`, { mode: 0o600 });
  await docker("volume", "create", volume);
  await docker("run", "--detach", "--init", "--name", name, "--publish", "127.0.0.1::3000", "--env-file", join(directory, "env"), "--mount", `type=volume,source=${volume},target=/app/.data`, image);
  const publishedOrigin = async () => `http://127.0.0.1:${(await docker("port", name, "3000/tcp")).split(":").at(-1)}`;
  let origin = await publishedOrigin();
  await ready(origin);
  assert.notEqual(await docker("exec", name, "id", "-u"), "0", "App must run as a non-root user");
  const headers = { authorization: `Bearer ${tokens[0]}`, "content-type": "application/json" };
  const created = await fetch(`${origin}/api/v1/records`, { method: "POST", headers, body: JSON.stringify({ title: "Persisted container record", content: "API, MCP and CLI share this record." }) });
  assert.equal(created.status, 201);
  const record = await created.json();
  assert.equal((await fetch(`${origin}/api/v1/records/${record.id}`, { headers: { authorization: `Bearer ${tokens[1]}` } })).status, 404);
  await docker("restart", "--time", "20", name);
  // Docker may allocate a different ephemeral host port after restarting.
  origin = await publishedOrigin();
  await ready(origin);
  const restored = await fetch(`${origin}/api/v1/records/${record.id}`, { headers });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), record);
  const smoke = await command("npm", ["run", "smoke:hosted"], {
    env: { ...process.env, APP_API_URL: origin, APP_API_TOKEN: tokens[0], APP_API_OTHER_TOKEN: tokens[1] },
  });
  assert.match(smoke, /Hosted smoke passed for/);
  assert.equal((await fetch(`${origin}/api/v1/records/${record.id}?revision=1`, { method: "DELETE", headers })).status, 204);
  console.log("Container passed: non-root runtime, readiness, owner isolation, restart persistence, REST, MCP and CLI.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Container validation failed.");
  console.error(await docker("logs", "--tail", "80", name).catch(() => "No container logs available."));
  process.exitCode = 1;
} finally {
  await docker("rm", "--force", name).catch(() => {});
  await docker("volume", "rm", volume).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
