import { DatabaseSync } from "node:sqlite";
import { lstatSync } from "node:fs";
import { isAbsolute,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { z } from "zod";
import { sqliteFencedTables } from "../lib/account-closure/sqlite-fences";
import { accountDataInventory,readAccountSchemaSources,verifyAccountDataInventory } from "./account-data-inventory.mjs";

type Owner = { tenant: string;subject: string };
function checkOwner(owner: Owner) {
  if (!owner.tenant || !owner.subject || owner.tenant.length > 200 || owner.subject.length > 200)
    throw new Error("A valid account owner is required.");
}

/** A permanent SQLite row-write fence. Only a fully initialized schema qualifies. */
export function setSqliteAccountFence(path: string,owner: Owner) {
  checkOwner(owner);
  if (!isAbsolute(path)) throw new Error("An absolute SQLite path is required.");
  const details = lstatSync(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("A real initialized SQLite file is required.");
  const db = new DatabaseSync(path,{ readOnly: false });
  try {
    db.exec("PRAGMA busy_timeout=5000; BEGIN IMMEDIATE");
    const covered = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()
      .map(row => String(row.name)).filter(name => name.endsWith("_account_fence_insert"))
      .map(name => name.slice(0,-"_account_fence_insert".length)));
    if (sqliteFencedTables.some(table => !covered.has(table))) throw new Error("SQLite account write-fence triggers are incomplete.");
    const result = db.prepare("INSERT INTO app_account_fences(tenant,subject) VALUES(?,?) ON CONFLICT DO NOTHING")
      .run(owner.tenant,owner.subject);
    db.exec("COMMIT");
    return { format: "ai-app-jumpstart-account-row-fence-v1",provider: "sqlite",status: "fenced",created: result.changes === 1,
      scope: "application-row INSERT/UPDATE in this database only; private objects, Auth, Eve/Workflow and external copies remain unfenced" };
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK");throw error; }
  finally { db.close(); }
}

/** The migration's advisory lock orders the fence against every guarded row write. */
export async function setPostgresAccountFence(url: string,owner: Owner) {
  checkOwner(owner);
  const expected = accountDataInventory.filter(entry => entry.sql && entry.owner !== "global-expiring" && entry.owner !== "closure-control")
    .map(entry => entry.sql);
  const client = new Client({ connectionString: url,connectionTimeoutMillis: 5_000,statement_timeout: 10_000 });
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await client.query(`SELECT c.relname FROM pg_catalog.pg_trigger t
      JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND t.tgname='app_account_fence_write' AND NOT t.tgisinternal`);
    const covered = new Set(result.rows.map(row => row.relname));
    if (expected.some(table => !covered.has(table))) throw new Error("PostgreSQL account write-fence triggers are incomplete.");
    const inserted = await client.query("INSERT INTO app_private.account_fences(tenant,subject) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING 1",[owner.tenant,owner.subject]);
    await client.query("COMMIT");
    return { format: "ai-app-jumpstart-account-row-fence-v1",provider: "postgres",status: "fenced",created: inserted.rowCount === 1,
      scope: "application-row INSERT/UPDATE in this database only; private objects, Auth, Eve/Workflow and external copies remain unfenced" };
  } catch (error) { await client.query("ROLLBACK").catch(() => {});throw error; }
  finally { await client.end(); }
}

/** A Convex mutation performs the indexed fence check and insert atomically. */
export async function setConvexAccountFence(siteUrl: string,secret: string,owner: Owner,request: typeof fetch = fetch) {
  checkOwner(owner);
  const url = new URL(siteUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)) ||
      secret.length < 32 || secret.length > 512) throw new Error("Invalid Convex account fence configuration.");
  const response = await request(new URL("/app/audit",url),{ method: "POST",redirect: "error",signal: AbortSignal.timeout(15_000),
    headers: { "content-type": "application/json","x-jumpstart-audit-key": secret },
    body: JSON.stringify({ operation: "setAccountFence",...owner }) });
  if (!response.ok) throw new Error("Convex account fence request failed.");
  const result = z.object({ status: z.literal("fenced"),created: z.boolean() }).strict().parse(await response.json());
  return { format: "ai-app-jumpstart-account-row-fence-v1",provider: "convex",...result,
    scope: "application-row mutations only; private objects, Auth, Eve/Workflow and external copies remain unfenced" };
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:fence:rows -- --metadata sqlite|postgres|convex --set-permanent (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT, plus the selected operator backend settings)";
  if (args.length !== 3 || args[0] !== "--metadata" || !["sqlite","postgres","convex"].includes(args[1]) ||
      args[2] !== "--set-permanent" || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    verifyAccountDataInventory(readAccountSchemaSources());
    const owner = { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT };
    const result = args[1] === "sqlite" ? setSqliteAccountFence(env.ACCOUNT_AUDIT_SQLITE_PATH ?? "",owner)
      : args[1] === "postgres" ? await setPostgresAccountFence(env.DATABASE_URL ?? "",owner)
      : await setConvexAccountFence(env.CONVEX_SITE_URL ?? "",env.CONVEX_AUDIT_SECRET ?? "",owner);
    console.log(JSON.stringify(result));
  } catch {
    console.error("Account row write fence failed. Check migrations, permissions and backend configuration.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
