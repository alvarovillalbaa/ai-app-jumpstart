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
  try { url = new URL(connectionString); } catch { throw new Error("DATABASE_URL must be a PostgreSQL URL."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || !url.pathname.slice(1) || url.hash)
    throw new Error("DATABASE_URL must name a PostgreSQL host, user and database without a fragment.");
  const env = { ...inherited };
  for (const key of Object.keys(env)) if (/^PG[A-Z_]+$/.test(key)) delete env[key];
  delete env.DATABASE_URL;
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

async function inspectDatabase(connectionString, empty = false) {
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
      return 0;
    }
    const result = await client.query("SELECT to_regclass('public.app_migrations') AS migrations, to_regclass('public.app_records') AS records");
    if (!result.rows[0].migrations || !result.rows[0].records)
      throw new Error("The selected database is not a migrated application database.");
    return Number((await client.query("SELECT count(*)::int AS count FROM public.app_migrations")).rows[0].count);
  } finally { await client.end(); }
}

/** Save one complete PostgreSQL database archive; optionally prove it restores locally. */
export async function backupPostgresApplication(sourceUrl, outputPath, verifyRestoreUrl) {
  if (!sourceUrl) throw new Error("Set DATABASE_URL to the application database to back up.");
  if (!outputPath || outputPath.includes("\u0000")) throw new Error("Provide a new backup output path.");
  const source = libpqEnvironment(sourceUrl);
  const output = resolve(outputPath);
  if (await lstat(output).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error("Backup destination already exists; choose a new path.");
  const migrationCount = await inspectDatabase(sourceUrl);
  let target;
  if (verifyRestoreUrl) {
    target = libpqEnvironment(verifyRestoreUrl);
    if (!["localhost", "127.0.0.1", "::1"].includes(target.host))
      throw new Error("Restore verification requires a loopback target database.");
    if (source.host === target.host && source.port === target.port && source.database === target.database)
      throw new Error("Restore target must differ from the backup source.");
    await inspectDatabase(verifyRestoreUrl, true);
  }

  const temporaryDirectory = await mkdtemp(join(dirname(output), ".postgres-backup-"));
  const temporary = join(temporaryDirectory, "application.dump");
  try {
    await chmod(temporaryDirectory, 0o700);
    await runClientTool("pg_dump", ["--format=custom", "--no-password", "--file", temporary], source.env);
    await chmod(temporary, 0o600);
    const archive = await runClientTool("pg_restore", ["--list", temporary], source.env, true);
    if (!archive.includes("app_migrations") || !archive.includes("app_records"))
      throw new Error("PostgreSQL archive lacks the application tables.");
    if (target) {
      await runClientTool("pg_restore", ["--single-transaction", "--exit-on-error", "--no-owner", "--no-acl", "--no-password", "--dbname", target.database, temporary], target.env);
      if (await inspectDatabase(verifyRestoreUrl) !== migrationCount)
        throw new Error("Restored application migration ledger differs from the source.");
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

async function main(args) {
  if (![2, 3].includes(args.length) || args[0] !== "--output" || !args[1] || args.length === 3 && args[2] !== "--verify-restore")
    throw new Error("Usage: npm run db:backup:postgres -- --output NEW_BACKUP.dump [--verify-restore]");
  const verifyUrl = args.length === 3 ? process.env.BACKUP_VERIFY_DATABASE_URL : undefined;
  if (args.length === 3 && !verifyUrl) throw new Error("Set BACKUP_VERIFY_DATABASE_URL to an empty disposable loopback database.");
  const result = await backupPostgresApplication(process.env.DATABASE_URL, args[1], verifyUrl);
  console.log(`Private PostgreSQL archive: ${result.output} (${result.bytes} bytes). ${result.restoreVerified ? "Disposable restore passed." : "Restore not rehearsed."}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : "PostgreSQL backup failed.");
    process.exitCode = 1;
  });
