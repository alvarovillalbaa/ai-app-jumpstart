import EmbeddedPostgres from "embedded-postgres";
import { appendFile, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { SignJWT } from "jose";
import { Client } from "pg";
import assert from "node:assert/strict";
import { installPostgrest } from "./testing/postgrest.mjs";
import { backupPostgresApplication, backupPostgresWorkflow } from "./backup-postgres.mjs";
import { createPostgresDatabaseSet, verifyPostgresDatabaseSet } from "./backup-postgres-databases.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const withSupabase = process.argv.includes("--supabase");
const backupOnly = process.argv.includes("--backup-only");
const directory = await mkdtemp(join(tmpdir(), "jumpstart-postgres-"));
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const password = randomBytes(24).toString("hex");
const database = new EmbeddedPostgres({
  databaseDir: join(directory, "data"), user: "jumpstart", password, port,
  persistent: true, authMethod: "scram-sha-256", createPostgresUser: false,
  postgresFlags: ["-h", "127.0.0.1", "-k", directory],
  onLog: () => {}, onError: () => {},
});
const env = { ...process.env, DATA_PROVIDER: "postgres", DATABASE_URL: `postgresql://jumpstart:${password}@127.0.0.1:${port}/app_test` };
let child;
let postgrest;
let proxy;
let restDiagnostics = "";
let validationFailed = false;
let stopping = false;
async function run(args, expectedCode = 0, commandEnv = env) {
  child = spawn(process.execPath, args, { cwd: root, env: commandEnv, stdio: expectedCode === 0 ? "inherit" : "ignore" });
  const [code, signal] = await once(child, "exit");
  child = undefined;
  if (code !== expectedCode || signal) throw new Error(`Database validation failed (${signal ?? code}, expected ${expectedCode}).`);
}
async function rehearseUpgrade() {
  // No release tag exists yet. This frozen migration boundary represents a
  // populated schema before the source-index and checkpoint upgrades.
  const baseline = "20260924233000_upload_cleanup_index.sql";
  const names = (await readdir(join(root, "migrations"))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  const boundary = names.indexOf(baseline);
  assert.ok(boundary >= 0 && boundary < names.length - 1, "Upgrade baseline must precede current migrations");
  await database.createDatabase("app_upgrade_test");
  const upgradeEnv = { ...env, DATABASE_URL: env.DATABASE_URL.replace(/\/app_test$/, "/app_upgrade_test") };
  const probe = new Client({ connectionString: upgradeEnv.DATABASE_URL });
  await probe.connect();
  const recordId = randomUUID();
  const conversationId = randomUUID();
  const operationId = randomUUID();
  const eventId = `evt_${"0".repeat(26)}`;
  const event = JSON.stringify({
    schemaVersion: 1, eventId, at: "2026-09-24T00:00:00.000Z", turnId: "upgrade-turn", sequence: 0,
    payload: { kind: "message", role: "user", parts: [{ type: "text", text: "Preserved across upgrade" }] },
  });
  try {
    await probe.query("BEGIN");
    if (withSupabase) await probe.query(`CREATE SCHEMA storage;
      CREATE TABLE storage.objects (bucket_id text NOT NULL, name text NOT NULL, PRIMARY KEY(bucket_id,name));
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE POLICY test_broad_storage ON storage.objects FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      INSERT INTO storage.objects(bucket_id,name) VALUES ('app-private-uploads','existing-private-object');`);
    await probe.query("CREATE TABLE app_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of names.slice(0, boundary + 1)) {
      await probe.query(await readFile(join(root, "migrations", name), "utf8"));
      await probe.query("INSERT INTO app_migrations(name) VALUES($1)", [name]);
    }
    await probe.query("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,$2,$3,$4,$5)",
      [recordId, "upgrade-tenant", "upgrade-owner", "Before upgrade", "Keep this private record"]);
    await probe.query(`INSERT INTO app_conversations(id,tenant,subject,operation_id,request_hash,session_id,status,title,created_at)
      VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8)`,
      [conversationId, "upgrade-tenant", "upgrade-owner", operationId, "a".repeat(64), "upgrade-session", "Before upgrade", 1]);
    await probe.query("INSERT INTO app_conversation_events(operation_id,event_id,payload) VALUES($1,$2,$3)", [operationId, eventId, event]);
    await probe.query("COMMIT");

    const appliedBefore = await probe.query("SELECT count(*)::int AS count FROM app_migrations");
    assert.equal(appliedBefore.rows[0].count, boundary + 1);
    assert.equal((await probe.query("SELECT 1 FROM information_schema.columns WHERE table_name='app_conversation_events' AND column_name='source_index'")).rowCount, 0);
    await run(["scripts/migrate.ts", "--dry-run"], 0, upgradeEnv);
    assert.equal((await probe.query("SELECT count(*)::int AS count FROM app_migrations")).rows[0].count, boundary + 1,
      "Upgrade dry-run changed the migration ledger");
    assert.equal((await probe.query("SELECT 1 FROM information_schema.columns WHERE table_name='app_conversation_events' AND column_name='source_index'")).rowCount, 0,
      "Upgrade dry-run changed the event schema");
    await run(["scripts/migrate.ts"], 0, upgradeEnv);
    await run(["scripts/migrate.ts"], 0, upgradeEnv);
    await run(["scripts/migrate.ts", "--dry-run"], 0, upgradeEnv);
    assert.equal((await probe.query("SELECT count(*)::int AS count FROM app_migrations")).rows[0].count, names.length);
    assert.deepEqual((await probe.query("SELECT title,content,revision FROM app_records WHERE id=$1", [recordId])).rows[0],
      { title: "Before upgrade", content: "Keep this private record", revision: 1 });
    assert.deepEqual((await probe.query("SELECT tenant,subject,status,projection_checkpoint FROM app_conversations WHERE operation_id=$1", [operationId])).rows[0],
      { tenant: "upgrade-tenant", subject: "upgrade-owner", status: "active", projection_checkpoint: "0" });
    assert.deepEqual((await probe.query("SELECT payload,source_index FROM app_conversation_events WHERE event_id=$1", [eventId])).rows[0],
      { payload: event, source_index: null });
    if (withSupabase) await probe.query("SET ROLE service_role");
    try {
      assert.equal((await probe.query("SELECT app_append_conversation_event($1,$2,$3,$4,$5,$6,$7) AS outcome",
        ["upgrade-tenant", "upgrade-owner", operationId, "upgrade-session", eventId, event, 7])).rows[0].outcome, "duplicate");
    } finally { if (withSupabase) await probe.query("RESET ROLE"); }
    assert.equal((await probe.query("SELECT source_index FROM app_conversation_events WHERE event_id=$1", [eventId])).rows[0].source_index, "7");
    if (withSupabase) {
      assert.equal((await probe.query(`SELECT has_function_privilege('authenticated',
        'public.app_append_conversation_event(text,text,uuid,text,text,text,bigint)','EXECUTE') AS allowed`)).rows[0].allowed, false);
      assert.equal((await probe.query(`SELECT polpermissive FROM pg_policy
        WHERE polrelid='storage.objects'::regclass AND polname='app_private_uploads_quarantine'`)).rows[0]?.polpermissive, false);
      assert.equal((await probe.query("SELECT count(*)::int AS count FROM storage.objects WHERE name='existing-private-object'")).rows[0].count, 1);
    }
    console.log(`Populated ${withSupabase ? "Supabase" : "PostgreSQL"} schema upgrade passed (${names.length - boundary - 1} later migrations).`);
  } catch (error) { await probe.query("ROLLBACK").catch(() => {}); throw error; }
  finally { await probe.end(); }
}
async function rehearseBackup() {
  const recordId = randomUUID();
  const source = new Client({ connectionString: env.DATABASE_URL });
  await source.connect();
  try {
    await source.query("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,$2,$3,$4,$5)",
      [recordId, "backup-tenant", "backup-owner", "Restored record", "private backup fixture"]);
  } finally { await source.end(); }
  await database.createDatabase("app_backup_restore_test");
  const restoreUrl = env.DATABASE_URL.replace(/\/app_test$/, "/app_backup_restore_test");
  const output = join(directory, "application.dump");
  const result = await backupPostgresApplication(env.DATABASE_URL, output, restoreUrl);
  assert.equal(result.restoreVerified, true);
  assert.ok(result.bytes > 0);
  assert.equal((await stat(output)).mode & 0o077, 0, "Published archive must be private");
  const restored = new Client({ connectionString: restoreUrl });
  await restored.connect();
  try {
    assert.deepEqual((await restored.query("SELECT tenant,subject,title,content,revision FROM app_records WHERE id=$1", [recordId])).rows[0],
      { tenant: "backup-tenant", subject: "backup-owner", title: "Restored record", content: "private backup fixture", revision: 1 });
    assert.equal((await restored.query("SELECT count(*)::int AS count FROM app_migrations")).rows[0].count,
      (await readdir(join(root, "migrations"))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).length);
  } finally { await restored.end(); }
  await assert.rejects(backupPostgresApplication(env.DATABASE_URL, output), /already exists/);
  await assert.rejects(backupPostgresApplication(env.DATABASE_URL, join(directory, "invalid.dump"), env.DATABASE_URL), /must differ/);
  await assert.rejects(backupPostgresWorkflow(env.DATABASE_URL, join(directory, "wrong-world.dump"), undefined, true),
    /not a migrated Eve Workflow database/);
  const archiveOnly = await backupPostgresApplication(env.DATABASE_URL, join(directory, "archive-only.dump"));
  assert.equal(archiveOnly.restoreVerified, false);
  const cliOutput = join(directory, "cli.dump");
  await run(["scripts/backup-postgres.mjs", "--output", cliOutput]);
  assert.equal((await stat(cliOutput)).mode & 0o077, 0);
  await database.createDatabase("app_cli_restore_test");
  const cliRestoreUrl = env.DATABASE_URL.replace(/\/app_test$/, "/app_cli_restore_test");
  await run(["scripts/backup-postgres.mjs", "--output", join(directory, "cli-restored.dump"), "--verify-restore"],
    0, { ...env, BACKUP_VERIFY_DATABASE_URL: cliRestoreUrl });
  const cliRestored = new Client({ connectionString: cliRestoreUrl });
  await cliRestored.connect();
  try {
    assert.equal((await cliRestored.query("SELECT content FROM app_records WHERE id=$1", [recordId])).rows[0].content,
      "private backup fixture");
  } finally { await cliRestored.end(); }
  const runner = process.env.PG_CLIENT_RUNNER;
  const failedOutput = join(directory, "failed.dump");
  process.env.PG_CLIENT_RUNNER = join(directory, "missing-pg-client");
  try { await assert.rejects(backupPostgresApplication(env.DATABASE_URL, failedOutput), /could not start/); }
  finally {
    if (runner === undefined) delete process.env.PG_CLIENT_RUNNER;
    else process.env.PG_CLIENT_RUNNER = runner;
  }
  assert.equal(await stat(failedOutput).then(() => true, () => false), false, "Failed dump must not publish a partial file");
  assert.equal((await readdir(directory)).some(name => name.startsWith(".postgres-backup-")), false,
    "Failed dump must remove its temporary archive");
  await database.createDatabase("workflow_pair_test");
  const workflowUrl = env.DATABASE_URL.replace(/\/app_test$/, "/workflow_pair_test");
  await run(["scripts/migrate-workflow.mjs"], 0,
    { ...env, WORKFLOW_POSTGRES_URL: workflowUrl, WORKFLOW_POSTGRES_JOB_PREFIX: "backup_pair_test" });
  await database.createDatabase("app_pair_restore_test");
  await database.createDatabase("workflow_pair_restore_test");
  const appPairRestoreUrl = env.DATABASE_URL.replace(/\/app_test$/, "/app_pair_restore_test");
  const workflowPairRestoreUrl = env.DATABASE_URL.replace(/\/app_test$/, "/workflow_pair_restore_test");
  const pairOutput = join(directory, "database-set");
  const pairEnv = { ...env, WORKFLOW_POSTGRES_URL: workflowUrl,
    BACKUP_VERIFY_APP_DATABASE_URL: appPairRestoreUrl,
    BACKUP_VERIFY_WORKFLOW_DATABASE_URL: workflowPairRestoreUrl };
  await run(["scripts/backup-postgres-databases.mjs", "--create", "--output", pairOutput,
    "--stopped", "--verify-restore"], 0, pairEnv);
  assert.equal((await verifyPostgresDatabaseSet(pairOutput)).restoreVerified, true);
  await run(["scripts/backup-postgres-databases.mjs", "--verify", pairOutput], 0,
    { ...env, DATABASE_URL: "", WORKFLOW_POSTGRES_URL: "" });
  assert.equal((await stat(pairOutput)).mode & 0o077, 0);
  const appRestored = new Client({ connectionString: appPairRestoreUrl });
  await appRestored.connect();
  try { assert.equal((await appRestored.query("SELECT content FROM app_records WHERE id=$1", [recordId])).rows[0].content,
    "private backup fixture"); }
  finally { await appRestored.end(); }
  const workflowRestored = new Client({ connectionString: workflowPairRestoreUrl });
  await workflowRestored.connect();
  try {
    assert.ok((await workflowRestored.query("SELECT count(*)::int AS count FROM workflow_drizzle.workflow_migrations")).rows[0].count > 0);
    assert.ok((await workflowRestored.query("SELECT count(*)::int AS count FROM graphile_worker.migrations")).rows[0].count > 0);
  } finally { await workflowRestored.end(); }
  await assert.rejects(createPostgresDatabaseSet({ applicationUrl: env.DATABASE_URL,
    workflowUrl, output: pairOutput, stopped: true }), /destination already exists/);
  await database.createDatabase("workflow_pair_missing_test");
  const missingWorkflowUrl = env.DATABASE_URL.replace(/\/app_test$/, "/workflow_pair_missing_test");
  const incompletePair = join(directory, "incomplete-database-set");
  await assert.rejects(createPostgresDatabaseSet({ applicationUrl: env.DATABASE_URL,
    workflowUrl: missingWorkflowUrl, output: incompletePair, stopped: true }), /not a migrated Eve Workflow database/);
  assert.equal(await stat(incompletePair).then(() => true, () => false), false,
    "A failed paired backup must not publish a partial directory");
  await appendFile(join(pairOutput, "application.dump"), "tampered");
  await assert.rejects(verifyPostgresDatabaseSet(pairOutput), /hashes or sizes differ/);
  console.log("Private PostgreSQL application and paired Workflow archives, restores and integrity checks passed.");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopping = true; child?.kill(signal);
});
try {
  await database.initialise();
  await database.start();
  await database.createDatabase("app_test");
  if (stopping) throw new Error("Interrupted.");
  await run(["scripts/migrate.ts", "--dry-run"]);
  const migrationProbe = new Client({ connectionString: env.DATABASE_URL });
  await migrationProbe.connect();
  try {
    const result = await migrationProbe.query("SELECT to_regclass('app_migrations')::text AS name");
    assert.equal(result.rows[0].name, null, "Migration dry-run must not create the ledger or schema");
  } finally { await migrationProbe.end(); }
  if (withSupabase) {
    const admin = new Client({ connectionString: env.DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        CREATE SCHEMA storage;
        CREATE TABLE storage.objects (bucket_id text NOT NULL, name text NOT NULL, PRIMARY KEY(bucket_id,name));
        ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
        GRANT USAGE ON SCHEMA storage TO anon, authenticated;
        GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon, authenticated;
        CREATE POLICY test_broad_storage ON storage.objects FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
        INSERT INTO storage.objects(bucket_id,name) VALUES ('app-private-uploads','private'),('other-bucket','other');`);
    } finally { await admin.end(); }
  }
  // Exercise the real migration runner twice: the second run must be safe.
  await run(["scripts/migrate.ts"]);
  await run(["scripts/migrate.ts"]);
  await run(["scripts/migrate.ts", "--dry-run"]);
  const driftProbe = new Client({ connectionString: env.DATABASE_URL });
  await driftProbe.connect();
  try {
    await driftProbe.query("INSERT INTO app_migrations(name) VALUES($1)", ["99999999_unknown.sql"]);
    await run(["scripts/migrate.ts", "--dry-run"], 1);
    await run(["scripts/migrate.ts"], 1);
    await driftProbe.query("DELETE FROM app_migrations WHERE name=$1", ["99999999_unknown.sql"]);
  } finally { await driftProbe.end(); }
  await rehearseUpgrade();
  if (backupOnly) await rehearseBackup();
  if (withSupabase) {
    const executable = await installPostgrest(join(directory, "postgrest"));
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const restPort = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const jwtSecret = randomBytes(32).toString("hex");
    postgrest = spawn(executable, [], { env: { ...process.env,
      PGRST_DB_URI: env.DATABASE_URL, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: jwtSecret, PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(restPort),
      ...(process.platform === "darwin" ? { DYLD_LIBRARY_PATH: join(root, `node_modules/@embedded-postgres/darwin-${process.arch}/native/lib`) } : {}),
    }, stdio: ["ignore", "ignore", "pipe"] });
    let restError;
    postgrest.on("error", error => { restError = error; });
    // Drain diagnostics but never print connection strings from a subprocess.
    postgrest.stderr.on("data", chunk => { restDiagnostics = (restDiagnostics + chunk.toString()).slice(-4000).replaceAll(env.DATABASE_URL, "[database]").replaceAll(password, "[redacted]").replaceAll(jwtSecret, "[redacted]"); });
    const deadline = Date.now() + 20_000;
    while (true) {
      if (restError || postgrest.exitCode !== null || postgrest.signalCode !== null) throw new Error(`PostgREST failed to start (${postgrest.signalCode ?? postgrest.exitCode ?? "spawn error"}).`);
      try { const response = await fetch(`http://127.0.0.1:${restPort}/`, { signal: AbortSignal.timeout(1000) }); if (response.ok) break; } catch {}
      if (Date.now() > deadline) throw new Error("PostgREST readiness timed out.");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Supabase's gateway maps /rest/v1/* onto PostgREST. This proxy only performs
    // that path mapping; all queries, JWT checks, SQL, RLS and grants run for real.
    proxy = createHttpServer(async (request, response) => {
      if (!request.url?.startsWith("/rest/v1/")) { response.writeHead(404); response.end(); return; }
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string" && !["host", "connection", "content-length", "transfer-encoding"].includes(key)) headers.set(key, value);
        const upstream = await fetch(`http://127.0.0.1:${restPort}${request.url.slice(8)}`, { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(10_000) });
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers)); response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502); response.end(); }
    });
    proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
    const token = role => new SignJWT({ role }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(new TextEncoder().encode(jwtSecret));
    env.DATA_PROVIDER = "supabase";
    env.SUPABASE_URL = `http://127.0.0.1:${proxy.address().port}`;
    env.SUPABASE_SECRET_KEY = await token("service_role");
    env.TEST_SUPABASE_ANON_TOKEN = await token("anon");
    env.TEST_SUPABASE_USER_TOKEN = await token("authenticated");
  }
  if (!backupOnly) await run(["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts"]);
  console.log(backupOnly ? "Disposable PostgreSQL: backup and restore contract passed."
    : withSupabase ? "Supabase adapter: real PostgreSQL/PostgREST contract and direct-access checks passed."
    : "Disposable PostgreSQL: migrations and repository contract passed.");
} catch (error) {
  validationFailed = true;
  console.error(error instanceof Error ? error.message : "Database validation failed.");
  if (restDiagnostics) console.error(restDiagnostics);
  process.exitCode = 1;
} finally {
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  if (postgrest && postgrest.exitCode === null && postgrest.signalCode === null) {
    const exited = once(postgrest, "exit");
    postgrest.kill("SIGTERM");
    const timeout = setTimeout(() => postgrest.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timeout);
  }
  await database.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
// embedded-postgres installs async exit hooks; make the final outcome explicit
// after all teardown work rather than relying on a mutable process.exitCode.
process.exit(validationFailed ? 1 : 0);
