import { DatabaseSync } from "node:sqlite";
import { lstat } from "node:fs/promises";
import { isAbsolute,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { sqliteFencedTables } from "../lib/account-closure/sqlite-fences";
import { accountDataInventory,accountOrphanCountQueries,accountOwnerCountQueries,accountOwnerDeleteQueries,
  readAccountSchemaSources,verifyAccountDataInventory } from "./account-data-inventory.mjs";
import { verifyAccountBundle } from "./export-account-bundle";
import { verifyAccountRowExportDetails } from "./export-account-rows";
import { eraseConvexAccountRows } from "./erase-convex-account-rows";

type Provider = "sqlite" | "postgres" | "convex";
type Expected = Record<string,number>;
const rows = accountDataInventory.filter(entry => entry.owner !== "global-expiring" && entry.owner !== "closure-control");

function count(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Account row count is invalid.");
  return number;
}

function assertCounts(actual: Expected,expected: Expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("Current application rows differ from the verified account bundle.");
}

async function sqlite(path: string,owner: AccessOwner,expected: Expected,execute: boolean) {
  if (!isAbsolute(path)) throw new Error("An absolute SQLite path is required.");
  const file = await lstat(path);
  if (!file.isFile() || file.isSymbolicLink()) throw new Error("A real initialized SQLite database is required.");
  const db = new DatabaseSync(path,{ timeout: 5_000 });
  try {
    db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'app_%'").all().map(row => String(row.name)));
    const classified = new Set(accountDataInventory.map(entry => entry.sqlite).filter(Boolean));
    if (tables.size !== classified.size || [...tables].some(table => !classified.has(table)))
      throw new Error("SQLite application schema differs from the account inventory.");
    const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(row => String(row.name)));
    if (sqliteFencedTables.some(table => !triggers.has(table+"_account_fence_insert") ||
        !triggers.has(table+"_account_fence_update")) ||
        !triggers.has("app_account_fences_no_update") || !triggers.has("app_account_fences_no_delete"))
      throw new Error("SQLite account write-fence guards are incomplete.");
    if (!db.prepare("SELECT 1 FROM app_account_fences WHERE tenant=? AND subject=?").get(owner.tenant,owner.subject))
      throw new Error("Account rows must be permanently fenced before erasure.");
    if (db.prepare("PRAGMA foreign_key_check").get()) throw new Error("SQLite foreign-key violations require investigation.");
    for (const query of accountOrphanCountQueries("sqlite"))
      if (count(db.prepare(query.sql).get()?.count) !== 0) throw new Error("Unattributable application rows require investigation.");
    const current = Object.fromEntries(accountOwnerCountQueries("sqlite").map(query =>
      [query.entity,count(db.prepare(query.sql).get(owner.tenant,owner.subject)?.count)]));
    assertCounts(current,expected);
    if (execute) {
      for (const query of accountOwnerDeleteQueries("sqlite")) {
        const deleted = db.prepare(query.sql).run(owner.tenant,owner.subject);
        if (count(deleted.changes) !== expected[query.entity]) throw new Error("Account deletion count changed; transaction rolled back.");
      }
      if (db.prepare("PRAGMA foreign_key_check").get()) throw new Error("Account deletion violated a foreign key.");
      for (const query of accountOwnerCountQueries("sqlite"))
        if (count(db.prepare(query.sql).get(owner.tenant,owner.subject)?.count) !== 0)
          throw new Error("Account application rows remain; transaction rolled back.");
      db.exec("COMMIT");
    } else db.exec("ROLLBACK");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK");throw error; }
  finally { db.close(); }
}

async function postgres(url: string,owner: AccessOwner,expected: Expected,execute: boolean) {
  const client = new Client({ connectionString: url,connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const tables = rows.filter(entry => entry.sql).map(entry => `public.${entry.sql}`);
    await client.query(`LOCK TABLE ${[...tables,"public.app_internal_nonces","app_private.account_fences"].join(",")} IN ACCESS EXCLUSIVE MODE`);
    const actualTables = (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ~ '^app_'"))
      .rows.map(row => row.tablename);
    const classified = new Set(accountDataInventory.filter(entry => entry.sql?.startsWith("app_")).map(entry => entry.sql));
    if (classified.size !== actualTables.filter(table => table !== "app_migrations").length ||
        actualTables.some(table => table !== "app_migrations" && !classified.has(table)))
      throw new Error("PostgreSQL application schema differs from the account inventory.");
    const restricted = await client.query("SELECT row_security_active(format('public.%I',table_name)::regclass) AS active FROM unnest($1::text[]) AS names(table_name)",
      [rows.filter(entry => entry.sql).map(entry => entry.sql)]);
    if (restricted.rows.some(row => row.active)) throw new Error("Account row erasure requires backend table access.");
    const triggerResult = await client.query("SELECT c.relname,t.tgtype,t.tgenabled,p.proname,fn.nspname AS function_schema FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace WHERE n.nspname='public' AND t.tgname='app_account_fence_write' AND NOT t.tgisinternal");
    const guarded = new Map(triggerResult.rows.map(row => [row.relname,row]));
    if (rows.some(entry => { if (!entry.sql) return false;const trigger = guarded.get(entry.sql);return !trigger ||
      (Number(trigger.tgtype) & 23) !== 23 || !["O","A"].includes(trigger.tgenabled) ||
      trigger.proname !== "account_fence_guard_write" || trigger.function_schema !== "app_private"; }))
      throw new Error("PostgreSQL account write-fence guards are incomplete.");
    const immutable = (await client.query("SELECT t.tgtype,t.tgenabled,p.proname,n.nspname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid='app_private.account_fences'::regclass AND t.tgname='app_account_fence_immutable' AND NOT t.tgisinternal")).rows;
    if (immutable.length !== 1 || (Number(immutable[0].tgtype) & 27) !== 27 ||
        !["O","A"].includes(immutable[0].tgenabled) || immutable[0].proname !== "account_fence_immutable" ||
        immutable[0].nspname !== "app_private")
      throw new Error("PostgreSQL account write-fence immutability guard is incomplete.");
    if (!(await client.query("SELECT 1 FROM app_private.account_fences WHERE tenant=$1 AND subject=$2",[owner.tenant,owner.subject])).rowCount)
      throw new Error("Account rows must be permanently fenced before erasure.");
    for (const query of accountOrphanCountQueries("sql"))
      if (count((await client.query(query.sql)).rows[0]?.count) !== 0) throw new Error("Unattributable application rows require investigation.");
    const current: Expected = {};
    for (const query of accountOwnerCountQueries("sql"))
      current[query.entity] = count((await client.query(query.sql,[owner.tenant,owner.subject])).rows[0]?.count);
    assertCounts(current,expected);
    if (execute) {
      for (const query of accountOwnerDeleteQueries("sql")) {
        const deleted = await client.query(query.sql,[owner.tenant,owner.subject]);
        if (count(deleted.rowCount) !== expected[query.entity]) throw new Error("Account deletion count changed; transaction rolled back.");
      }
      for (const query of accountOwnerCountQueries("sql"))
        if (count((await client.query(query.sql,[owner.tenant,owner.subject])).rows[0]?.count) !== 0)
          throw new Error("Account application rows remain; transaction rolled back.");
      await client.query("COMMIT");
    } else await client.query("ROLLBACK");
  } catch (error) { await client.query("ROLLBACK").catch(() => {});throw error; }
  finally { await client.end(); }
}

/** Operator-only application-row erasure; the permanent fence survives. */
export async function eraseAccountRows(provider: Provider,ownerInput: AccessOwner,bundlePath: string,
  env: Record<string,string | undefined>,execute = false,request: typeof fetch = fetch) {
  verifyAccountDataInventory(readAccountSchemaSources());
  const owner = accessOwner.parse(ownerInput);
  const bundle = await verifyAccountBundle(bundlePath);
  const archive = await verifyAccountRowExportDetails(join(resolve(bundlePath),"rows.ndjson"));
  if (bundle.metadataProvider !== provider || archive.provider !== provider ||
      archive.owner.tenant !== owner.tenant || archive.owner.subject !== owner.subject || archive.rows !== bundle.rows)
    throw new Error("Verified account bundle does not match the selected owner and metadata provider.");
  let convexResult: { remainingBefore: number;deleted: number } | undefined;
  if (provider === "sqlite") await sqlite(env.ACCOUNT_AUDIT_SQLITE_PATH ?? "",owner,archive.counts,execute);
  else if (provider === "postgres") await postgres(env.DATABASE_URL ?? "",owner,archive.counts,execute);
  else convexResult = await eraseConvexAccountRows(owner,bundlePath,archive.counts,
    env.CONVEX_SITE_URL ?? "",env.CONVEX_AUDIT_SECRET ?? "",env.CONVEX_ERASURE_SECRET ?? "",execute,request);
  return { provider,rows: archive.rows,status: execute ? "application-rows-erased" : "application-row-erasure-planned",
    ...convexResult,
    scope: provider === "convex"
      ? "resumable bounded application-row mutations; permanent fence retained; objects, Auth, Eve/Workflow and external copies remain"
      : "transactional application metadata rows only; permanent fence retained; objects, Auth, Eve/Workflow and external copies remain" };
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:erase:rows -- --metadata sqlite|postgres|convex --source /private/bundle --stopped --plan|--erase-application-rows (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT and selected operator backend settings; Convex execution also needs a distinct CONVEX_ERASURE_SECRET)";
  if (args.length !== 6 || args[0] !== "--metadata" || !["sqlite","postgres","convex"].includes(args[1]) ||
      args[2] !== "--source" || !args[3] || args[4] !== "--stopped" ||
      !["--plan","--erase-application-rows"].includes(args[5]) || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    const result = await eraseAccountRows(args[1] as Provider,
      { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },args[3],env,
      args[5] === "--erase-application-rows");
    console.log(JSON.stringify(result));
  } catch {
    console.error("Account row erasure failed. Check the verified bundle, permanent fence, schema, stopped writers and backend access.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
