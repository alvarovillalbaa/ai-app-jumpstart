import { DatabaseSync } from "node:sqlite";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { z } from "zod";

export const nativeTables = ["workflow_runs", "workflow_steps", "workflow_events", "workflow_hooks",
  "workflow_stream_chunks", "workflow_waits", "workflow_event_slots", "workflow_invocations"];
export const graphileTables = ["_private_jobs", "_private_job_queues", "_private_tasks"];
export const terminalRunStatuses = new Set(["completed","failed","cancelled"]);

export const linkedRunsCte = `WITH RECURSIVE linked(id) AS (
  SELECT id FROM workflow.workflow_runs WHERE id = ANY($1::text[])
    OR attributes->>'$eve.root' = ANY($1::text[])
    OR attributes->>'$eve.parent' = ANY($1::text[])
  UNION
  SELECT child.id FROM workflow.workflow_runs child JOIN linked parent
    ON child.attributes->>'$eve.parent' = parent.id OR child.attributes->>'$eve.root' = parent.id
)`;

function count(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Unsupported Workflow count.");
  return number;
}

function sumCounts(values) {
  const total = values.reduce((sum,value) => sum + value,0);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Unsupported Workflow total.");
  return total;
}

function validIds(rows) {
  if (!Array.isArray(rows) || rows.length > 100_000 || rows.some(row => typeof row.session_id !== "string" ||
      row.session_id.length === 0 || row.session_id.length > 512))
    throw new Error("Unsupported account session inventory.");
  return rows.map(row => row.session_id);
}

async function convexBoundSessions(owner,env,request) {
  let url;
  try { url = new URL(env.CONVEX_SITE_URL ?? ""); } catch { throw new Error("A valid Convex audit origin is required."); }
  const secret = env.CONVEX_AUDIT_SECRET ?? "";
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)) ||
      secret.length < 32 || secret.length > 512) throw new Error("A valid Convex audit origin and credential are required.");
  const endpoint = new URL("/app/audit",url),pageSchema = z.object({
    sessionIds: z.array(z.string().min(1).max(512)).max(100),scanned: z.number().int().min(0).max(100),
    done: z.boolean(),cursor: z.string().nullable(),
  }).strict();
  const ids = [],seen = new Set();
  let cursor = null,pages = 0;
  do {
    if (++pages > 100_000) throw new Error("Convex account session inspection exceeded the page limit.");
    const response = await request(endpoint,{ method: "POST",redirect: "error",signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json","x-jumpstart-audit-key": secret },
      body: JSON.stringify({ operation: "accountSessionPage",tenant: owner.tenant,subject: owner.subject,cursor }) });
    if (!response.ok) throw new Error("Convex account session inspection request failed.");
    const page = pageSchema.parse(await response.json());
    if (page.done !== (page.cursor === null) || !page.done && (!page.scanned || page.cursor === cursor) ||
        page.sessionIds.length > page.scanned) throw new Error("Convex account session inspection returned an invalid page.");
    for (const id of page.sessionIds) {
      if (seen.has(id) || ids.length >= 100_000) throw new Error("Convex account session inventory is invalid or too large.");
      seen.add(id);ids.push(id);
    }
    cursor = page.cursor;
  } while (cursor !== null);
  return ids;
}

async function boundSessions(metadataProvider, owner, env,request) {
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
  if (metadataProvider === "convex") return convexBoundSessions(owner,env,request);
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
export async function inspectAccountWorkflow(metadataProvider, owner, env,request = fetch) {
  const jobPrefix = env.WORKFLOW_POSTGRES_JOB_PREFIX ?? "";
  if (!owner?.tenant || !owner?.subject || owner.tenant.length > 200 || owner.subject.length > 200 ||
      !["sqlite", "postgres", "convex"].includes(metadataProvider) || !env.WORKFLOW_POSTGRES_URL ||
      !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(jobPrefix))
    throw new Error("Invalid Workflow account inspection configuration.");
  const ids = await boundSessions(metadataProvider, owner, env,request);
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
    const graphileSchema = await db.query(`SELECT tablename, row_security_active(format('graphile_worker.%I',tablename)::regclass) AS restricted
      FROM pg_tables WHERE schemaname='graphile_worker' AND tablename=ANY($1::text[])`,[graphileTables]);
    const presentGraphile = new Map(graphileSchema.rows.map(row => [row.tablename,row.restricted]));
    if (graphileTables.some(table => !presentGraphile.has(table) || presentGraphile.get(table)))
      throw new Error("Unsupported or restricted Graphile Worker schema.");
    const flowTask = `${jobPrefix}flows`,taskNames = [flowTask,`${flowTask}_executor`];
    const queuePrefix = `${flowTask}:`;
    const result = await db.query(`${linkedRunsCte}
      SELECT
        (SELECT count(*) FROM linked) AS runs,
        (SELECT count(*) FROM workflow.workflow_runs WHERE id IN (SELECT id FROM linked)
          AND status::text = ANY($2::text[])) AS terminal_runs,
        (SELECT count(*) FROM workflow.workflow_runs WHERE id IN (SELECT id FROM linked)
          AND (status IS NULL OR NOT (status::text = ANY($2::text[])))) AS nonterminal_runs,
        (SELECT count(*) FROM workflow.workflow_steps WHERE run_id IN (SELECT id FROM linked)) AS steps,
        (SELECT count(*) FROM workflow.workflow_events WHERE run_id IN (SELECT id FROM linked)) AS events,
        (SELECT count(*) FROM workflow.workflow_hooks WHERE run_id IN (SELECT id FROM linked)) AS hooks,
        (SELECT count(*) FROM workflow.workflow_stream_chunks WHERE run_id IN (SELECT id FROM linked)) AS stream_chunks,
        (SELECT count(*) FROM workflow.workflow_waits WHERE run_id IN (SELECT id FROM linked)) AS waits,
        (SELECT count(*) FROM workflow.workflow_event_slots WHERE run_id IN (SELECT id FROM linked)) AS event_slots,
        (SELECT count(*) FROM workflow.workflow_invocations WHERE run_id IN (SELECT id FROM linked)) AS invocations,
        (SELECT count(*) FROM workflow.workflow_runs WHERE id NOT IN (SELECT id FROM linked)) AS unattributed_runs,
        (SELECT count(*) FROM workflow.workflow_steps WHERE run_id IS NULL OR run_id NOT IN (SELECT id FROM linked)) AS unattributed_steps,
        (SELECT count(*) FROM workflow.workflow_events WHERE run_id IS NULL OR run_id NOT IN (SELECT id FROM linked)) AS unattributed_events,
        (SELECT count(*) FROM workflow.workflow_hooks WHERE run_id IS NULL OR run_id NOT IN (SELECT id FROM linked)) AS unattributed_hooks,
        (SELECT count(*) FROM workflow.workflow_stream_chunks WHERE run_id IS NULL OR run_id NOT IN (SELECT id FROM linked)) AS unattributed_stream_chunks,
        (SELECT count(*) FROM workflow.workflow_waits WHERE run_id IS NULL OR run_id NOT IN (SELECT id FROM linked)) AS unattributed_waits,
        (SELECT count(*) FROM workflow.workflow_event_slots WHERE run_id IS NULL OR run_id NOT IN (SELECT id FROM linked)) AS unattributed_event_slots,
        (SELECT count(*) FROM workflow.workflow_invocations WHERE run_id IS NULL OR run_id NOT IN (SELECT id FROM linked)) AS unattributed_invocations,
        (SELECT count(*) FROM workflow.workflow_runs WHERE attributes->>'$eve.type'='session' AND id NOT IN (SELECT id FROM linked)) AS other_session_roots`,
    [ids,[...terminalRunStatuses]]);
    const graphileJobsResult = await db.query(`${linkedRunsCte}, linked_ids(id) AS (
        SELECT id FROM linked UNION SELECT unnest($1::text[])
      ), linked_queues AS (
        SELECT $3::text || id || ':executor' AS queue_name FROM linked_ids
      ), selected_jobs AS (
        SELECT jobs.locked_by,jobs.payload,tasks.identifier AS task_identifier,
          (COALESCE(queues.queue_name IN (SELECT queue_name FROM linked_queues),false) OR
            (tasks.identifier=ANY($2::text[]) AND
              COALESCE(jobs.payload->>'runId' IN (SELECT id FROM linked_ids),false))) AS is_linked
        FROM graphile_worker._private_jobs jobs
        JOIN graphile_worker._private_tasks tasks ON tasks.id=jobs.task_id
        LEFT JOIN graphile_worker._private_job_queues queues ON queues.id=jobs.job_queue_id
        WHERE tasks.identifier=ANY($2::text[]) OR
          (queues.queue_name IS NOT NULL AND left(queues.queue_name,char_length($3))=$3 AND right(queues.queue_name,9)=':executor')
      )
      SELECT count(*) FILTER (WHERE is_linked) AS linked,
        count(*) FILTER (WHERE NOT is_linked) AS unattributed,
        count(*) FILTER (WHERE is_linked AND locked_by IS NOT NULL) AS locked_linked,
        count(*) FILTER (WHERE is_linked AND task_identifier=$4 AND payload->>'__healthCheck'='true') AS pending_start_checks,
        count(*) FILTER (WHERE is_linked AND NOT (task_identifier=ANY($2::text[]))) AS unsupported_linked
      FROM selected_jobs`,[ids,taskNames,queuePrefix,flowTask]);
    const graphileQueuesResult = await db.query(`${linkedRunsCte}, linked_ids(id) AS (
        SELECT id FROM linked UNION SELECT unnest($1::text[])
      ), linked_queues AS (
        SELECT $2::text || id || ':executor' AS queue_name FROM linked_ids
      )
      SELECT count(*) FILTER (WHERE queue_name IN (SELECT queue_name FROM linked_queues)) AS linked,
        count(*) FILTER (WHERE queue_name NOT IN (SELECT queue_name FROM linked_queues)) AS unattributed,
        count(*) FILTER (WHERE queue_name IN (SELECT queue_name FROM linked_queues) AND locked_by IS NOT NULL) AS locked_linked
      FROM graphile_worker._private_job_queues
      WHERE queue_name IN (SELECT queue_name FROM linked_queues) OR
        (left(queue_name,char_length($2))=$2 AND right(queue_name,9)=':executor')`,[ids,queuePrefix]);
    await db.query("COMMIT");
    const row = result.rows[0];
    const unattributedWorkflowRows = {
      runs: count(row.unattributed_runs),steps: count(row.unattributed_steps),events: count(row.unattributed_events),
      hooks: count(row.unattributed_hooks),streamChunks: count(row.unattributed_stream_chunks),waits: count(row.unattributed_waits),
      eventSlots: count(row.unattributed_event_slots),invocations: count(row.unattributed_invocations),
    };
    const unattributedWorkflowRowCount = sumCounts(Object.values(unattributedWorkflowRows));
    const jobRow = graphileJobsResult.rows[0],queueRow = graphileQueuesResult.rows[0];
    const graphileJobs = { linked: count(jobRow.linked),unattributed: count(jobRow.unattributed),
        lockedLinked: count(jobRow.locked_linked),pendingStartChecks: count(jobRow.pending_start_checks),
        unsupportedLinked: count(jobRow.unsupported_linked) };
    const graphileQueues = { linked: count(queueRow.linked),unattributed: count(queueRow.unattributed),
      lockedLinked: count(queueRow.locked_linked) };
    const graphile = { jobs: graphileJobs,executorQueues: graphileQueues,
      linkedRowCount: sumCounts([graphileJobs.linked,graphileQueues.linked]),
      unattributedRowCount: sumCounts([graphileJobs.unattributed,graphileQueues.unattributed]) };
    return { format: "ai-app-jumpstart-account-workflow-observation-v3", metadataProvider,
      workflowProvider: "postgres", boundSessionCount: ids.length,
      linkedRuns: { runs: count(row.runs), terminalRuns: count(row.terminal_runs),
        nonterminalRuns: count(row.nonterminal_runs), steps: count(row.steps), events: count(row.events),
        hooks: count(row.hooks), streamChunks: count(row.stream_chunks), waits: count(row.waits),
        eventSlots: count(row.event_slots), invocations: count(row.invocations) },
      unattributedWorkflowRows,unattributedWorkflowRowCount,
      graphile,
      otherSessionRoots: count(row.other_session_roots),
      scope: "two read-only snapshots; native PostgreSQL Workflow rows and Graphile jobs/executor queues under the configured job prefix are counted separately. Graphile jobs are linked by a bound-session run ID or its exact executor queue; global unmatched jobs and queues may belong to other accounts and return no identifiers. Unattributed native run and child-row counts include rootless/auxiliary rows. Pending start health checks, worker-held linked jobs/queues, and unsupported task jobs on linked queues are reported but not cancelled. Local/managed Workflow, Auth, providers, logs and backups are not included. No write fence or erasure certificate." };
  } catch (error) { await db.query("ROLLBACK").catch(() => {}); throw error; } finally { await db.end(); }
}

async function main(args, env) {
  const usage = "Usage: npm run account:inspect:workflow -- --metadata sqlite|postgres|convex --read-only (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT, WORKFLOW_POSTGRES_URL, WORKFLOW_POSTGRES_JOB_PREFIX and the selected application backend settings in the operator environment)";
  if (args.length !== 3 || args[0] !== "--metadata" || !["sqlite", "postgres", "convex"].includes(args[1]) ||
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
