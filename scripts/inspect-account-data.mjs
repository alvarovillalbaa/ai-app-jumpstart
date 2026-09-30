import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { accountDataInventory, accountOrphanCountQueries, accountOwnerCountQueries, readAccountSchemaSources, verifyAccountDataInventory } from "./account-data-inventory.mjs";

function count(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("Account row count exceeded the supported range.");
  return result;
}

function total(rows) {
  return count(Object.values(rows).reduce((sum, value) => sum + value, 0));
}

function report(provider, ownerRows, orphanRows, applicationWriteFenced) {
  return {
    format: "ai-app-jumpstart-account-data-inspection-v1",
    provider,
    ownerRows,
    orphanRows,
    ownerRowTotal: total(ownerRows),
    orphanRowTotal: total(orphanRows),
    applicationWriteFenced,
    scope: "single application database snapshot including the permanent application-row fence; this report does not inspect private object bytes, Auth, Eve, providers, logs or backups",
  };
}

/** Backend-only, consistent application-row inventory. Never expose this through an account API. */
export function inspectSqliteAccountData(path, tenant, subject) {
  const db = new DatabaseSync(path, { readOnly: true, timeout: 5_000 });
  try {
    db.exec("BEGIN");
    const ownerRows = Object.fromEntries(accountOwnerCountQueries("sqlite").map(query =>
      [query.entity, count(db.prepare(query.sql).get(tenant, subject).count)]));
    const orphanRows = Object.fromEntries(accountOrphanCountQueries("sqlite").map(query =>
      [query.entity, count(db.prepare(query.sql).get().count)]));
    const applicationWriteFenced = db.prepare(`SELECT EXISTS(
      SELECT 1 FROM app_account_fences WHERE tenant=? AND subject=?) AS fenced`).get(tenant,subject).fenced === 1;
    db.exec("COMMIT");
    return report("sqlite", ownerRows, orphanRows, applicationWriteFenced);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally { db.close(); }
}

/** Use the backend database credential, including for the Supabase application schema. */
export async function inspectPostgresAccountData(connectionString, tenant, subject) {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // An RLS-limited role can return false zeroes, so require a backend role
    // that sees every classified application table before counting anything.
    const tables = accountDataInventory.filter(entry => entry.sql && entry.owner !== "closure-control")
      .map(entry => entry.sql);
    const access = await client.query(`SELECT table_name, row_security_active(format('public.%I', table_name)::regclass) AS restricted
      FROM unnest($1::text[]) AS names(table_name)`, [tables]);
    if (access.rows.some(row => row.restricted)) throw new Error("Account inspection requires backend table access.");
    const ownerRows = {};
    for (const query of accountOwnerCountQueries("sql"))
      ownerRows[query.entity] = count((await client.query(query.sql, [tenant, subject])).rows[0].count);
    const orphanRows = {};
    for (const query of accountOrphanCountQueries("sql"))
      orphanRows[query.entity] = count((await client.query(query.sql)).rows[0].count);
    const applicationWriteFenced = (await client.query(`SELECT EXISTS(
      SELECT 1 FROM app_private.account_fences WHERE tenant=$1 AND subject=$2) AS fenced`,[tenant,subject])).rows[0].fenced;
    await client.query("COMMIT");
    return report("postgres", ownerRows, orphanRows, applicationWriteFenced);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { await client.end(); }
}

const usage = "Usage: npm run account:inspect -- --sqlite PATH | --postgres (set ACCOUNT_AUDIT_TENANT and ACCOUNT_AUDIT_SUBJECT in the environment; PostgreSQL also needs DATABASE_URL)";

async function main(args, env) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  if (args.length !== (args[0] === "--sqlite" ? 2 : 1) ||
    (args[0] !== "--sqlite" && args[0] !== "--postgres") || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT ||
    (args[0] === "--sqlite" && !args[1]) || (args[0] === "--postgres" && !env.DATABASE_URL))
    throw new Error(usage);
  verifyAccountDataInventory(readAccountSchemaSources());
  const result = args[0] === "--sqlite"
    ? inspectSqliteAccountData(resolve(args[1]), env.ACCOUNT_AUDIT_TENANT, env.ACCOUNT_AUDIT_SUBJECT)
    : await inspectPostgresAccountData(env.DATABASE_URL, env.ACCOUNT_AUDIT_TENANT, env.ACCOUNT_AUDIT_SUBJECT);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2), process.env).catch(error => {
    // Database errors may include identities, paths or connection strings.
    console.error(error instanceof Error && error.message === usage ? usage :
      "Account data inspection failed. Check arguments, backend connectivity, permissions and schema.");
    process.exitCode = error instanceof Error && error.message === usage ? 2 : 1;
  });
