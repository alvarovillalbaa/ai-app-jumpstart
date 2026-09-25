import { chmod, link, lstat, mkdtemp, open, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const queryEnvironment = new Map([
  ["sslmode", "PGSSLMODE"], ["sslrootcert", "PGSSLROOTCERT"],
  ["sslcert", "PGSSLCERT"], ["sslkey", "PGSSLKEY"],
  ["connect_timeout", "PGCONNECT_TIMEOUT"], ["application_name", "PGAPPNAME"],
  ["target_session_attrs", "PGTARGETSESSIONATTRS"], ["options", "PGOPTIONS"],
  ["channel_binding", "PGCHANNELBINDING"], ["gssencmode", "PGGSSENCMODE"],
]);

/** Pass the URL to libpq without putting a database password in process arguments. */
export function libpqEnvironment(connectionString, inherited = process.env) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error("The connection must be a PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1) || url.hash)
    throw new Error("The PostgreSQL URL must name a host, user and database without a fragment.");
  const env = { ...inherited };
  for (const key of Object.keys(env)) if (/^PG[A-Z_]+$/.test(key)) delete env[key];
  delete env.DATABASE_URL;
  delete env.WORKFLOW_POSTGRES_URL;
  delete env.BACKUP_VERIFY_DATABASE_URL;
  env.PGHOST = url.hostname.replace(/^\[|\]$/g, "");
  env.PGPORT = url.port || "5432";
  env.PGUSER = decodeURIComponent(url.username);
  env.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
  if (url.password) env.PGPASSWORD = decodeURIComponent(url.password);
  env.PGCONNECT_TIMEOUT = "10";
  const seen = new Set();
  for (const [name, value] of url.searchParams) {
    const setting = queryEnvironment.get(name);
    if (!setting || seen.has(name)) throw new Error(`Unsupported or repeated PostgreSQL URL option: ${name}.`);
    seen.add(name);
    env[setting] = value;
  }
  return { env, host: env.PGHOST, port: env.PGPORT, database: env.PGDATABASE };
}

async function runClientTool(tool, args, env, capture = false) {
  const runner = process.env.PG_CLIENT_RUNNER;
  const child = spawn(runner || tool, runner ? [tool, ...args] : args, {
    env, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", chunk => {
    if (capture) {
      output += chunk.toString();
      if (output.length > 8_000_000) child.kill();
    }
  });
  // Client diagnostics can include connection details; print a fixed error instead.
  child.stderr.resume();
  await new Promise((finish, fail) => {
    child.once("error", () => fail(new Error(`${tool} could not start. Install PostgreSQL client tools.`)));
    child.once("close", (code, signal) => code === 0 && !signal
      ? finish() : fail(new Error(`${tool} failed (${signal ?? code}). Check the database, permissions and that the client major version is at least the server's.`)));
  });
  return output;
}

async function inspectDatabase(connectionString, kind, empty = false) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    if (empty) {
      const result = await client.query(`SELECT EXISTS (
        SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp_%'
          AND c.relkind IN ('r','p','v','m','f','S')
      ) AS occupied`);
      if (result.rows[0].occupied) throw new Error("Restore target must be an empty disposable database.");
      return null;
    }
    if (kind === "application") {
      const result = await client.query("SELECT to_regclass('public.app_migrations') AS migrations, to_regclass('public.app_records') AS records");
      if (!result.rows[0].migrations || !result.rows[0].records)
        throw new Error("The selected database is not a migrated application database.");
      return { migrations: Number((await client.query("SELECT count(*)::int AS count FROM public.app_migrations")).rows[0].count) };
    }
    const result = await client.query(`SELECT
      to_regclass('workflow.workflow_runs') AS runs,
      to_regclass('workflow.workflow_events') AS events,
      to_regclass('workflow.workflow_stream_chunks') AS chunks,
      to_regclass('workflow_drizzle.workflow_migrations') AS workflow_migrations,
      to_regclass('graphile_worker.migrations') AS worker_migrations,
      to_regclass('graphile_worker.jobs') AS jobs`);
    if (Object.values(result.rows[0]).some(value => !value))
      throw new Error("The selected database is not a migrated Eve Workflow database.");
    const counts = await client.query(`SELECT
      (SELECT count(*)::int FROM workflow_drizzle.workflow_migrations) AS workflow_migrations,
      (SELECT count(*)::int FROM graphile_worker.migrations) AS worker_migrations,
      (SELECT count(*)::int FROM workflow.workflow_runs) AS runs,
      (SELECT count(*)::int FROM workflow.workflow_events) AS events,
      (SELECT count(*)::int FROM graphile_worker.jobs WHERE locked_by IS NOT NULL) AS locked_jobs`);
    if (counts.rows[0].locked_jobs !== 0)
      throw new Error("Workflow database has locked jobs; stop every worker and resolve them before backing up.");
    const snapshot = { ...counts.rows[0] };
    delete snapshot.locked_jobs;
    return snapshot;
  } finally { await client.end(); }
}

/** Save one complete PostgreSQL database archive; optionally prove it restores locally. */
async function backupPostgresDatabase(sourceUrl, outputPath, verifyRestoreUrl, kind) {
  if (!sourceUrl) throw new Error(`Set ${kind === "workflow" ? "WORKFLOW_POSTGRES_URL" : "DATABASE_URL"} to the database to back up.`);
  if (!outputPath || outputPath.includes("\u0000")) throw new Error("Provide a new backup output path.");
  const source = libpqEnvironment(sourceUrl);
  const output = resolve(outputPath);
  if (await lstat(output).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error("Backup destination already exists; choose a new path.");
  const sourceSnapshot = await inspectDatabase(sourceUrl, kind);
  let target;
  if (verifyRestoreUrl) {
    target = libpqEnvironment(verifyRestoreUrl);
    if (!["localhost", "127.0.0.1", "::1"].includes(target.host))
      throw new Error("Restore verification requires a loopback target database.");
    if (source.host === target.host && source.port === target.port && source.database === target.database)
      throw new Error("Restore target must differ from the backup source.");
    await inspectDatabase(verifyRestoreUrl, kind, true);
  }

  const temporaryDirectory = await mkdtemp(join(dirname(output), ".postgres-backup-"));
  const temporary = join(temporaryDirectory, `${kind}.dump`);
  try {
    await chmod(temporaryDirectory, 0o700);
    await runClientTool("pg_dump", ["--format=custom", "--no-password", "--file", temporary], source.env);
    await chmod(temporary, 0o600);
    const archive = await runClientTool("pg_restore", ["--list", temporary], source.env, true);
    const required = kind === "workflow"
      ? ["workflow_runs", "workflow_events", "workflow_migrations", "_private_jobs"]
      : ["app_migrations", "app_records"];
    if (required.some(name => !archive.includes(name)))
      throw new Error(`PostgreSQL archive lacks the required ${kind} tables.`);
    if (target) {
      await runClientTool("pg_restore", ["--single-transaction", "--exit-on-error", "--no-owner", "--no-acl", "--no-password", "--dbname", target.database, temporary], target.env);
      const restoredSnapshot = await inspectDatabase(verifyRestoreUrl, kind);
      if (Object.keys(sourceSnapshot).some(key => sourceSnapshot[key] !== restoredSnapshot[key]))
        throw new Error(`Restored ${kind} database counts differ from the source.`);
    }
    const handle = await open(temporary, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, output); }
    catch (error) {
      if (error.code === "EEXIST") throw new Error("Backup destination already exists; choose a new path.");
      throw error;
    }
    return { output, bytes: (await stat(output)).size, restoreVerified: Boolean(target) };
  } finally { await rm(temporaryDirectory, { recursive: true, force: true }); }
}

export function backupPostgresApplication(sourceUrl, outputPath, verifyRestoreUrl) {
  return backupPostgresDatabase(sourceUrl, outputPath, verifyRestoreUrl, "application");
}

export function backupPostgresWorkflow(sourceUrl, outputPath, verifyRestoreUrl, stopped = false) {
  if (!stopped) throw new Error("Stop all Eve Workflow writers and pass --stopped before a Workflow backup.");
  return backupPostgresDatabase(sourceUrl, outputPath, verifyRestoreUrl, "workflow");
}

async function main(args) {
  const workflow = args[0] === "--workflow";
  const options = workflow ? args.slice(1) : args;
  const usage = workflow
    ? "Usage: npm run workflow:backup -- --output NEW_BACKUP.dump --stopped [--verify-restore]"
    : "Usage: npm run db:backup:postgres -- --output NEW_BACKUP.dump [--verify-restore]";
  if (options[0] !== "--output" || !options[1] ||
      (workflow ? ![3, 4].includes(options.length) || options[2] !== "--stopped" || options.length === 4 && options[3] !== "--verify-restore"
        : ![2, 3].includes(options.length) || options.length === 3 && options[2] !== "--verify-restore"))
    throw new Error(usage);
  const verify = workflow ? options.length === 4 : options.length === 3;
  const verifyUrl = verify ? process.env.BACKUP_VERIFY_DATABASE_URL : undefined;
  if (verify && !verifyUrl) throw new Error("Set BACKUP_VERIFY_DATABASE_URL to an empty disposable loopback database.");
  const result = workflow
    ? await backupPostgresWorkflow(process.env.WORKFLOW_POSTGRES_URL, options[1], verifyUrl, true)
    : await backupPostgresApplication(process.env.DATABASE_URL, options[1], verifyUrl);
  console.log(`Private PostgreSQL archive: ${result.output} (${result.bytes} bytes). ${result.restoreVerified ? "Disposable restore passed." : "Restore not rehearsed."}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : "PostgreSQL backup failed.");
    process.exitCode = 1;
  });
