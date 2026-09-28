import { DatabaseSync } from "node:sqlite";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const nativeTables = ["workflow_runs", "workflow_steps", "workflow_events", "workflow_hooks",
  "workflow_stream_chunks", "workflow_waits", "workflow_event_slots"];

function count(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Unsupported Workflow count.");
  return number;
}

function validIds(rows) {
  if (!Array.isArray(rows) || rows.length > 100_000 || rows.some(row => typeof row.session_id !== "string" ||
      row.session_id.length === 0 || row.session_id.length > 512))
    throw new Error("Unsupported account session inventory.");
  return rows.map(row => row.session_id);
}

async function boundSessions(metadataProvider, owner, env) {
  if (metadataProvider === "sqlite") {
    if (!env.ACCOUNT_AUDIT_SQLITE_PATH || !isAbsolute(env.ACCOUNT_AUDIT_SQLITE_PATH))
      throw new Error("An absolute SQLite audit path is required.");
    const db = new DatabaseSync(env.ACCOUNT_AUDIT_SQLITE_PATH, { readOnly: true, timeout: 5_000 });
    try {
      db.exec("BEGIN");
      const rows = db.prepare("SELECT session_id FROM app_conversations WHERE tenant=? AND subject=? AND session_id IS NOT NULL").all(owner.tenant, owner.subject);
      const ids = validIds(rows);
      db.exec("COMMIT");
      return ids;
    } catch (error) { db.exec("ROLLBACK"); throw error; } finally { db.close(); }
  }
  if (metadataProvider !== "postgres" || !env.DATABASE_URL) throw new Error("A PostgreSQL application audit URL is required.");
  const db = new Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
  await db.connect();
  try {
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL statement_timeout = '15s'");
    const access = await db.query("SELECT row_security_active('public.app_conversations'::regclass) AS restricted");
    if (access.rows[0].restricted) throw new Error("Backend application table access is required.");
    const ids = validIds((await db.query("SELECT session_id FROM public.app_conversations WHERE tenant=$1 AND subject=$2 AND session_id IS NOT NULL", [owner.tenant, owner.subject])).rows);
    await db.query("COMMIT");
    return ids;
  } catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; } finally { await db.end(); }
}

/** Read-only inventory of PostgreSQL Workflow runs traceable to application session bindings. */
export async function inspectAccountWorkflow(metadataProvider, owner, env) {
  if (!owner?.tenant || !owner?.subject || owner.tenant.length > 200 || owner.subject.length > 200 ||
      !["sqlite", "postgres"].includes(metadataProvider) || !env.WORKFLOW_POSTGRES_URL)
    throw new Error("Invalid Workflow account inspection configuration.");
  const ids = await boundSessions(metadataProvider, owner, env);
  const db = new Client({ connectionString: env.WORKFLOW_POSTGRES_URL, connectionTimeoutMillis: 5_000 });
  await db.connect();
  try {
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL statement_timeout = '30s'");
    const schema = await db.query(`SELECT tablename, row_security_active(format('workflow.%I', tablename)::regclass) AS restricted
      FROM pg_tables WHERE schemaname='workflow'`);
    const present = new Map(schema.rows.map(row => [row.tablename, row.restricted]));
    if (nativeTables.some(table => !present.has(table) || present.get(table)) ||
        [...present.keys()].some(table => table.startsWith("workflow_") && !nativeTables.includes(table)))
      throw new Error("Unsupported or restricted Workflow schema.");
    const result = await db.query(`WITH RECURSIVE linked(id) AS (
        SELECT id FROM workflow.workflow_runs WHERE id = ANY($1::text[])
          OR attributes->>'$eve.root' = ANY($1::text[])
          OR attributes->>'$eve.parent' = ANY($1::text[])
        UNION
        SELECT child.id FROM workflow.workflow_runs child JOIN linked parent
          ON child.attributes->>'$eve.parent' = parent.id OR child.attributes->>'$eve.root' = parent.id
      )
      SELECT
        (SELECT count(*) FROM linked) AS runs,
        (SELECT count(*) FROM workflow.workflow_steps WHERE run_id IN (SELECT id FROM linked)) AS steps,
        (SELECT count(*) FROM workflow.workflow_events WHERE run_id IN (SELECT id FROM linked)) AS events,
        (SELECT count(*) FROM workflow.workflow_hooks WHERE run_id IN (SELECT id FROM linked)) AS hooks,
        (SELECT count(*) FROM workflow.workflow_stream_chunks WHERE run_id IN (SELECT id FROM linked)) AS stream_chunks,
        (SELECT count(*) FROM workflow.workflow_waits WHERE run_id IN (SELECT id FROM linked)) AS waits,
        (SELECT count(*) FROM workflow.workflow_event_slots WHERE run_id IN (SELECT id FROM linked)) AS event_slots,
        (SELECT count(*) FROM workflow.workflow_runs WHERE attributes->>'$eve.type'='session' AND id NOT IN (SELECT id FROM linked)) AS other_session_roots`, [ids]);
    await db.query("COMMIT");
    const row = result.rows[0];
    return { format: "ai-app-jumpstart-account-workflow-observation-v1", metadataProvider,
      workflowProvider: "postgres", boundSessionCount: ids.length,
      linkedRuns: { runs: count(row.runs), steps: count(row.steps), events: count(row.events),
        hooks: count(row.hooks), streamChunks: count(row.stream_chunks), waits: count(row.waits), eventSlots: count(row.event_slots) },
      otherSessionRoots: count(row.other_session_roots),
      scope: "two read-only snapshots; linked PostgreSQL Workflow rows only. Other session roots are global and may belong to other accounts; unlinked auxiliary runs, local/managed Workflow, Auth, providers, logs and backups are not attributed. No write fence or erasure certificate." };
  } catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; } finally { await db.end(); }
}

async function main(args, env) {
  const usage = "Usage: npm run account:inspect:workflow -- --metadata sqlite|postgres --read-only (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT, WORKFLOW_POSTGRES_URL and selected application backend settings in the operator environment)";
  if (args.length !== 3 || args[0] !== "--metadata" || !["sqlite", "postgres"].includes(args[1]) ||
      args[2] !== "--read-only" || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT) {
    console.error(usage); process.exitCode = 2; return;
  }
  try {
    console.log(JSON.stringify(await inspectAccountWorkflow(args[1],
      { tenant: env.ACCOUNT_AUDIT_TENANT, subject: env.ACCOUNT_AUDIT_SUBJECT }, env), null, 2));
  } catch {
    console.error("Workflow account inspection failed. Check operator access, configuration and schema.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void main(process.argv.slice(2), process.env);
