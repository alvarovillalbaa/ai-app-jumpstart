import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const image = process.env.TEST_WORKFLOW_IMAGE ?? "ai-app-jumpstart:workflow-postgres-test";
const project = `jumpstartwf${randomBytes(5).toString("hex")}`;
const token = randomBytes(32).toString("base64url");
const appPassword = randomBytes(24).toString("hex");
const workflowPassword = randomBytes(24).toString("hex");
const env = { ...process.env, POSTGRES_PASSWORD: appPassword, WORKFLOW_DB_PASSWORD: workflowPassword };
const directory = await mkdtemp(join(tmpdir(), "jumpstart-workflow-compose-"));
const override = join(directory, "override.yaml");
let compose, started = false;

function redact(value) {
  return value.replaceAll(appPassword, "[redacted]").replaceAll(workflowPassword, "[redacted]").replaceAll(token, "[redacted]");
}
function command(executable, args, { inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, env, stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", chunk => { output = (output + chunk).slice(-9000); });
    child.stderr?.on("data", chunk => { output = (output + chunk).slice(-9000); });
    child.on("error", reject);
    child.on("close", (code, signal) => code === 0 ? resolve(output.trim()) : reject(new Error(redact(`${executable} failed (${signal ?? code}): ${output}`))));
  });
}
const docker = (...args) => command("docker", args);
async function freePort() {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await new Promise(resolve => listener.once("listening", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}
async function waitForReady(origin) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/api/health/ready`, { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (response?.ok) return response.json();
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error("Application and agent did not become ready.");
}

try {
  compose = await command("docker", ["compose", "version"]).then(() => args => command("docker", ["compose", ...args])).catch(async () => {
    await command("docker-compose", ["version"]);
    return args => command("docker-compose", args);
  });
  if (!process.argv.includes("--skip-build")) {
    console.log("Building the PostgreSQL Workflow image...");
    await command("docker", ["build", "--build-arg", "EVE_WORKFLOW_PROVIDER=postgres", "-t", image, "."], { inherit: true });
  } else await docker("image", "inspect", image);

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const keys = [{ sha256: createHash("sha256").update(token).digest("hex"), tenant: project, subject: "owner", scopes: ["records:read", "records:write"] }];
  await writeFile(override, `services:
  app:
    image: ${JSON.stringify(image)}
    build: !reset null
    env_file: !reset []
    ports: !override ["127.0.0.1:${port}:3000"]
    environment:
      APP_ORIGIN: ${JSON.stringify(origin)}
      APP_API_KEYS: ${JSON.stringify(JSON.stringify(keys))}
  migrate:
    image: ${JSON.stringify(image)}
    build: !reset null
  workflow-migrate:
    image: ${JSON.stringify(image)}
    build: !reset null
`, { mode: 0o600 });
  const files = ["-p", project, "-f", "compose.yaml", "-f", "compose.postgres.yaml", "-f", "compose.workflow-postgres.yaml", "-f", override];
  const stack = (...args) => compose([...files, ...args]);
  started = true;
  await stack("up", "--no-build", "--wait", "--wait-timeout", "150", "-d");
  for (const service of ["migrate", "workflow-migrate"]) {
    const id = await stack("ps", "-a", "-q", service);
    assert.ok(id, `${service} must have run`);
    assert.equal(await docker("inspect", "--format", "{{.State.ExitCode}}", id), "0", `${service} must complete successfully`);
  }
  assert.deepEqual(await waitForReady(origin), { status: "ready", checks: { data: "ok", agent: "ok" } });
  const eve = await fetch(`${origin}/eve/v1/health`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(eve.status, 200);
  assert.equal((await eve.json()).status, "ready");
  const workflowTables = Number(await stack("exec", "-T", "workflow-db", "psql", "-U", "workflow", "-d", "workflow", "-Atqc", "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')"));
  assert.ok(workflowTables > 0, "Workflow migration must create database tables");
  const expectedMigrations = (await readdir(join(root,"migrations"))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  const appliedMigrations = (await stack("exec", "-T", "postgres", "psql", "-U", "app", "-d", "app", "-Atqc", "SELECT name FROM app_migrations ORDER BY name"))
    .split("\n").filter(Boolean);
  assert.deepEqual(appliedMigrations,expectedMigrations,"The container migration job must apply every source migration");
  assert.equal(await stack("exec", "-T", "postgres", "psql", "-U", "app", "-d", "app", "-Atqc", "SELECT to_regclass('public.budget_outstanding_time') IS NOT NULL"),"t","Outstanding-budget index must exist");
  assert.equal(await stack("exec", "-T", "postgres", "psql", "-U", "app", "-d", "app", "-Atqc",
    "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='app_artifacts' AND column_name='deleted_at')"),"t","Artifact retention column must exist");
  assert.equal(await stack("exec", "-T", "postgres", "psql", "-U", "app", "-d", "app", "-Atqc",
    "SELECT to_regprocedure('public.app_delete_artifact(text,text,uuid,bigint)') IS NOT NULL"),"t","Artifact deletion function must exist");

  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const created = await fetch(`${origin}/api/v1/records`, { method: "POST", headers, body: JSON.stringify({ title: "Workflow Compose proof", content: "Persists across app replacement." }) });
  assert.equal(created.status, 201);
  const record = await created.json();
  assert.match(record.id, /^[a-f0-9-]{36}$/);
  assert.equal(await stack("exec", "-T", "postgres", "psql", "-U", "app", "-d", "app", "-Atqc", `SELECT count(*) FROM public.app_records WHERE id='${record.id}'`), "1", "Record must be in application PostgreSQL");
  const originalApp = await stack("ps", "-q", "app");
  await stack("up", "--no-build", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", "90", "-d", "app");
  assert.notEqual(await stack("ps", "-q", "app"), originalApp, "App container must be replaced");
  assert.deepEqual(await waitForReady(origin), { status: "ready", checks: { data: "ok", agent: "ok" } });
  const restored = await fetch(`${origin}/api/v1/records/${record.id}`, { headers });
  assert.equal(restored.status, 200);
  assert.deepEqual(await restored.json(), record);
  const replayedEve = await fetch(`${origin}/eve/v1/health`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(replayedEve.status, 200);
  assert.equal((await replayedEve.json()).status, "ready");
  console.log(`Workflow Compose passed: ${appliedMigrations.length} application migrations, Workflow schema, ${workflowTables} workflow tables, app/Eve health, and PostgreSQL record persistence after app replacement.`);
} catch (error) {
  console.error(redact(error instanceof Error ? error.message : "Workflow Compose validation failed."));
  if (started) {
    const files = ["-p", project, "-f", "compose.yaml", "-f", "compose.postgres.yaml", "-f", "compose.workflow-postgres.yaml", "-f", override];
    const logs = await compose([...files, "logs", "--no-color", "--tail", "40", "app", "migrate", "workflow-migrate", "postgres", "workflow-db"]).catch(() => "");
    if (logs) console.error(redact(logs));
  }
  process.exitCode = 1;
} finally {
  if (started) {
    const files = ["-p", project, "-f", "compose.yaml", "-f", "compose.postgres.yaml", "-f", "compose.workflow-postgres.yaml", "-f", override];
    await compose([...files, "down", "--volumes", "--remove-orphans"]).catch(error => { console.error(redact(error.message)); process.exitCode = 1; });
  }
  await rm(directory, { recursive: true, force: true });
}
