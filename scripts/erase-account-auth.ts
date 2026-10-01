import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { isAbsolute,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { z } from "zod";
import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { sqliteFencedTables } from "../lib/account-closure/sqlite-fences";
import { trustedHttpOrigin } from "../lib/security/origin";
import { accountDataInventory } from "./account-data-inventory.mjs";
import { objectSourceSha256 } from "./account-object-source";
import { supabaseAuthAdmin } from "./account-auth-admin";
import { verifyAccountBundle } from "./export-account-bundle";
import { verifyAccountRowExportDetails } from "./export-account-rows";
import { inspectAccountClosure } from "./inspect-account-closure";

type MetadataProvider = "sqlite" | "postgres" | "convex";

async function requirePermanentFence(provider: MetadataProvider,owner: AccessOwner,
  env: Record<string,string | undefined>,request: typeof fetch) {
  if (provider === "sqlite") {
    const path = env.ACCOUNT_AUDIT_SQLITE_PATH ?? "";
    if (!isAbsolute(path)) throw new Error("An absolute SQLite path is required.");
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("A real initialized SQLite database is required.");
    const db = new DatabaseSync(path,{ readOnly: true,timeout: 5_000 });
    try {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'app_%'").all()
        .map(row => String(row.name)));
      const classified = new Set(accountDataInventory.map(entry => entry.sqlite).filter(Boolean));
      if (tables.size !== classified.size || [...tables].some(table => !classified.has(table)) ||
          db.prepare("PRAGMA foreign_key_check").get())
        throw new Error("SQLite application schema or foreign keys require investigation.");
      const triggers = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()
        .map(row => String(row.name)));
      if (sqliteFencedTables.some(table => !triggers.has(table+"_account_fence_insert") ||
          !triggers.has(table+"_account_fence_update")) ||
          !triggers.has("app_account_fences_no_update") || !triggers.has("app_account_fences_no_delete") ||
          !db.prepare("SELECT 1 FROM app_account_fences WHERE tenant=? AND subject=?").get(owner.tenant,owner.subject))
        throw new Error("Account application-row fence or guards are missing.");
    } finally { db.close(); }
    return;
  }
  if (provider === "postgres") {
    const client = new Client({ connectionString: env.DATABASE_URL ?? "",connectionTimeoutMillis: 5_000,statement_timeout: 10_000 });
    await client.connect();
    try {
      const actualTables = (await client.query<{ tablename: string }>("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename ~ '^app_'"))
        .rows.map(row => row.tablename);
      const classified = new Set(accountDataInventory.filter(entry => entry.sql?.startsWith("app_") &&
        !entry.sql.includes(".")).map(entry => entry.sql));
      if (classified.size !== actualTables.filter(table => table !== "app_migrations").length ||
          actualTables.some(table => table !== "app_migrations" && !classified.has(table)))
        throw new Error("PostgreSQL application schema differs from the account inventory.");
      const expected = accountDataInventory.filter(entry => entry.sql && entry.owner !== "global-expiring" && entry.owner !== "closure-control")
        .map(entry => entry.sql);
      const result = await client.query(`SELECT c.relname,t.tgtype,t.tgenabled,p.proname,fn.nspname AS function_schema FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace
        WHERE n.nspname='public' AND t.tgname='app_account_fence_write' AND NOT t.tgisinternal`);
      const covered = new Map(result.rows.map(row => [row.relname,row]));
      if (expected.some(table => { const trigger = covered.get(table);return !trigger ||
        (Number(trigger.tgtype) & 23) !== 23 || !["O","A"].includes(trigger.tgenabled) ||
        trigger.proname !== "account_fence_guard_write" || trigger.function_schema !== "app_private"; }))
        throw new Error("Account application-row fence guards are missing.");
      const immutable = (await client.query("SELECT t.tgtype,t.tgenabled,p.proname,n.nspname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid='app_private.account_fences'::regclass AND t.tgname='app_account_fence_immutable' AND NOT t.tgisinternal")).rows;
      if (immutable.length !== 1 || (Number(immutable[0].tgtype) & 27) !== 27 ||
          !["O","A"].includes(immutable[0].tgenabled) || immutable[0].proname !== "account_fence_immutable" ||
          immutable[0].nspname !== "app_private")
        throw new Error("Account application-row fence immutability guard is missing.");
      if ((await client.query("SELECT 1 FROM app_private.account_fences WHERE tenant=$1 AND subject=$2",[owner.tenant,owner.subject])).rowCount !== 1)
        throw new Error("Account application-row fence is missing.");
    } finally { await client.end(); }
    return;
  }
  const url = trustedHttpOrigin(env.CONVEX_SITE_URL),secret = env.CONVEX_AUDIT_SECRET ?? "";
  if (!url || secret.length < 32 || secret.length > 512) throw new Error("Invalid Convex account fence configuration.");
  const response = await request(new URL("/app/audit",url),{ method: "POST",redirect: "error",signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json","x-jumpstart-audit-key": secret },
    body: JSON.stringify({ operation: "accountFenceStatus",...owner }) });
  if (!response.ok || !z.object({ fenced: z.literal(true) }).strict().safeParse(await response.json()).success)
    throw new Error("Account application-row fence is missing.");
}

/** Operator-only Auth hard deletion after the selected archived app stores are empty. */
export async function eraseAccountAuth(ownerInput: AccessOwner,bundlePath: string,
  env: Record<string,string | undefined>,execute = false,request: typeof fetch = fetch) {
  const owner = accessOwner.parse(ownerInput);
  const { auth } = supabaseAuthAdmin(owner,env,request);
  const bundle = await verifyAccountBundle(bundlePath);
  const rows = await verifyAccountRowExportDetails(join(resolve(bundlePath),"rows.ndjson"));
  if (bundle.metadataProvider !== rows.provider || bundle.objectSourceSha256 === undefined ||
      rows.owner.tenant !== owner.tenant || rows.owner.subject !== owner.subject ||
      await objectSourceSha256(bundle.objectProvider,env) !== bundle.objectSourceSha256)
    throw new Error("Verified source-bound bundle does not match the account and selected object store.");
  await requirePermanentFence(bundle.metadataProvider,owner,env,request);
  const observation = await inspectAccountClosure(bundle.metadataProvider,bundle.objectProvider,owner,env,request);
  if (observation.ownerRowTotal !== 0 || observation.orphanRowTotal !== 0 || observation.objectCount !== 0)
    throw new Error("Application rows, unattributable rows or private objects remain.");
  const before = await auth.getUserById(owner.subject);
  if (before.error?.status === 404) return { status: "auth-identity-already-absent",scope: "selected Supabase Auth user only" };
  if (before.error || before.data.user?.id !== owner.subject || before.data.user.is_anonymous ||
      before.data.user.role !== "authenticated") throw new Error("Auth user could not be verified for this owner.");
  if (!execute) return { status: "auth-identity-erasure-planned",scope: "selected Supabase Auth user only" };
  const deleted = await auth.deleteUser(owner.subject,false);
  if (deleted.error) throw new Error("Supabase Auth hard deletion failed.");
  const after = await auth.getUserById(owner.subject);
  if (after.error?.status !== 404) throw new Error("Supabase Auth deletion could not be verified.");
  return { status: "auth-identity-erased",scope: "selected Supabase Auth user and refresh sessions; outstanding access JWTs may survive until expiry" };
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:erase:auth -- --source /private/bundle --stopped --plan|--erase-auth-identity (set AUTH_PROVIDER=supabase, ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT, SUPABASE_AUTH_URL and SUPABASE_AUTH_ADMIN_KEY plus selected backend operator settings)";
  if (args.length !== 4 || args[0] !== "--source" || !args[1] || args[2] !== "--stopped" ||
      !["--plan","--erase-auth-identity"].includes(args[3]) || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    console.log(JSON.stringify(await eraseAccountAuth({ tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },
      args[1],env,args[3] === "--erase-auth-identity")));
  } catch {
    console.error("Account Auth erasure failed. Check the verified bundle, exact Auth origin, permanent fence, zero selected-store counts and operator access.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
