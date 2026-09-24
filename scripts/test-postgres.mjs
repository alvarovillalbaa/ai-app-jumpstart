import EmbeddedPostgres from "embedded-postgres";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { SignJWT } from "jose";
import { Client } from "pg";
import assert from "node:assert/strict";
import { installPostgrest } from "./testing/postgrest.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const withSupabase = process.argv.includes("--supabase");
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
async function run(args, expectedCode = 0) {
  child = spawn(process.execPath, args, { cwd: root, env, stdio: expectedCode === 0 ? "inherit" : "ignore" });
  const [code, signal] = await once(child, "exit");
  child = undefined;
  if (code !== expectedCode || signal) throw new Error(`Database validation failed (${signal ?? code}, expected ${expectedCode}).`);
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
  await run(["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts"]);
  console.log(withSupabase ? "Supabase adapter: real PostgreSQL/PostgREST contract and direct-access checks passed." : "Disposable PostgreSQL: migrations and repository contract passed.");
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
