import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

// Honors DOCKER_CONTEXT/DOCKER_HOST without changing the operator's defaults.
const image = process.env.TEST_CONTAINER_IMAGE ?? "ai-app-jumpstart:test";
const name = `jumpstart-contract-${randomBytes(6).toString("hex")}`;
const restoredName = `${name}-restored`;
const volume = `${name}-data`;
const eveVolume = `${name}-eve`;
const backupVolume = `${name}-backup`;
const restoredVolume = `${name}-restored-data`;
const restoredEveVolume = `${name}-restored-eve`;
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
async function ready(origin, container = name) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/health/ready`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (response?.ok) {
      assert.deepEqual(await response.json(), { status: "ready", checks: { data: "ok", agent: "ok" } });
      return;
    }
    if (await docker("inspect", "--format", "{{.State.Running}}", container) !== "true") throw new Error("Container stopped before readiness.");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Container did not become ready within 90 seconds.");
}
try {
  if (!process.argv.includes("--skip-build")) {
    console.log("Building the production container...");
    await docker("build", "-t", image, ".");
  }
  const listener = createServer();
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const hostPort = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${hostPort}`;
  await writeFile(join(directory, "env"), `APP_ORIGIN=${origin}\nAPP_API_KEYS=${JSON.stringify(keys)}\nDATA_PROVIDER=sqlite\nSQLITE_PATH=/app/.data/app.sqlite\n`, { mode: 0o600 });
  for (const selected of [volume,eveVolume,backupVolume,restoredVolume,restoredEveVolume]) await docker("volume", "create", selected);
  await docker("run", "--detach", "--init", "--name", name, "--publish", `127.0.0.1:${hostPort}:3000`, "--env-file", join(directory, "env"),
    "--mount", `type=volume,source=${volume},target=/app/.data`,"--mount", `type=volume,source=${eveVolume},target=/app/.eve`,image);
  await ready(origin);
  assert.notEqual(await docker("exec", name, "id", "-u"), "0", "App must run as a non-root user");
  const headers = { authorization: `Bearer ${tokens[0]}`, "content-type": "application/json", origin };
  const created = await fetch(`${origin}/api/v1/records`, { method: "POST", headers, body: JSON.stringify({ title: "Persisted container record", content: "API, MCP and CLI share this record." }) });
  assert.equal(created.status, 201);
  const record = await created.json();
  assert.equal((await fetch(`${origin}/api/v1/records/${record.id}`, { headers: { authorization: `Bearer ${tokens[1]}` } })).status, 404);
  await docker("stop", "--time", "20", name);
  const backupMount = `type=volume,source=${backupVolume},target=/app/.backup`;
  const snapshot = "/app/.backup/snapshot",restoredRoot = "/app/.backup/restored";
  const localSnapshot = await docker("run", "--rm", "--volumes-from", name, "--mount", backupMount, "--entrypoint", "node", image,
    "scripts/backup-local.mjs", "--create", "--app-db", "/app/.data/app.sqlite",
    "--workflow-dir", "/app/.eve/.workflow-data", "--no-uploads", "--output", snapshot, "--stopped");
  assert.match(localSnapshot, /Verified local snapshot:/);
  assert.match(await docker("run", "--rm", "--mount", backupMount, "--entrypoint", "node", image,
    "scripts/backup-local.mjs", "--verify", snapshot), /Local snapshot verified:/);
  assert.match(await docker("run", "--rm", "--mount", backupMount, "--entrypoint", "node", image,
    "scripts/backup-local.mjs", "--restore", snapshot, "--output", restoredRoot), /Local snapshot restored to new directory:/);
  const install = `import { cp,lstat,stat } from "node:fs/promises";
    for (const [source,target] of [["/app/.backup/restored/app.sqlite","/app/.data/app.sqlite"],
      ["/app/.backup/restored/workflow","/app/.eve/.workflow-data"]]) {
      const exists = await lstat(target).then(() => true,error => { if (error.code === "ENOENT") return false; throw error; });
      if (exists) throw new Error("Refusing to replace an installed recovery target.");
      await cp(source,target,{ recursive: true,force: false,errorOnExist: true });
      if (((await stat(target)).mode & 0o077) !== 0) throw new Error("Restored data is not private.");
    }
    console.log("Installed verified snapshot into fresh volumes.");`;
  assert.match(await docker("run", "--rm", "--mount", backupMount,
    "--mount", `type=volume,source=${restoredVolume},target=/app/.data`,
    "--mount", `type=volume,source=${restoredEveVolume},target=/app/.eve`,
    "--entrypoint", "node", image, "--input-type=module", "-e", install), /Installed verified snapshot/);
  await docker("run", "--detach", "--init", "--name", restoredName, "--publish", `127.0.0.1:${hostPort}:3000`, "--env-file", join(directory, "env"),
    "--mount", `type=volume,source=${restoredVolume},target=/app/.data`,
    "--mount", `type=volume,source=${restoredEveVolume},target=/app/.eve`,image);
  await ready(origin,restoredName);
  const restored = await fetch(`${origin}/api/v1/records/${record.id}`, { headers });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), record);
  assert.equal((await fetch(`${origin}/api/v1/records/${record.id}`, { headers: { authorization: `Bearer ${tokens[1]}` } })).status, 404);
  const smoke = await command("npm", ["run", "smoke:hosted"], {
    env: { ...process.env, APP_API_URL: origin, APP_API_TOKEN: tokens[0], APP_API_OTHER_TOKEN: tokens[1] },
  });
  assert.match(smoke, /Hosted smoke passed for/);
  assert.equal((await fetch(`${origin}/api/v1/records/${record.id}?revision=1`, { method: "DELETE", headers })).status, 204);
  console.log("Container passed: non-root runtime, off-volume private snapshot, fresh-volume restore, owner isolation, REST, MCP and CLI.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Container validation failed.");
  console.error(await docker("logs", "--tail", "80", restoredName).catch(() => "No restored container logs available."));
  console.error(await docker("logs", "--tail", "80", name).catch(() => "No source container logs available."));
  process.exitCode = 1;
} finally {
  await docker("rm", "--force", restoredName).catch(() => {});
  await docker("rm", "--force", name).catch(() => {});
  for (const selected of [volume,eveVolume,backupVolume,restoredVolume,restoredEveVolume]) await docker("volume", "rm", selected).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
