import { createHash } from "node:crypto";
import { constants as fsConstants,type BigIntStats } from "node:fs";
import { lstat,open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { Client } from "pg";
import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { nativeTables,linkedRunsCte,terminalRunStatuses } from "./inspect-account-workflow.mjs";
import { verifyAccountWorkflowExportDetails } from "./export-account-workflow";

const MAX_JOBS = 200_000;
const MAX_ROWS = 200_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_BATCH_ROWS = 100;
type Table = typeof nativeTables[number];

function ownerDigest(owner: AccessOwner) {
  return createHash("sha256").update(JSON.stringify([owner.tenant,owner.subject])).digest("hex");
}

function sameValues(left: string[],right: string[]) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function sameFileVersion(left: BigIntStats,right: BigIntStats) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

async function loadArchiveRows(db: Client,path: string,expected: Awaited<ReturnType<typeof verifyAccountWorkflowExportDetails>>) {
  const file = await open(resolve(path),fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | fsConstants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true }),pathBefore = await lstat(resolve(path),{ bigint: true });
    if (!sameFileVersion(before,pathBefore) || (before.mode & BigInt(0o077)) !== BigInt(0) ||
        before.size < BigInt(1) || before.size > BigInt(MAX_BYTES))
      throw new Error("Workflow archive is unsafe or changed.");
    await db.query(`CREATE TEMP TABLE jumpstart_workflow_archive_rows (
      table_name text NOT NULL,row_json jsonb NOT NULL) ON COMMIT DROP`);
    const hash = createHash("sha256"),counts = Object.fromEntries(nativeTables.map(table => [table,0])) as Record<Table,number>;
    const batch: Array<{ table: Table;rowJson: string }> = [];
    let batchBytes = 0,bytes = 0,total = 0,ended = false,footerHash = "";
    async function flush() {
      if (!batch.length) return;
      const values: unknown[] = [];
      const tuples = batch.map(row => {
        values.push(row.table,row.rowJson);
        return `($${values.length-1},$${values.length}::jsonb)`;
      });
      await db.query(`INSERT INTO pg_temp.jumpstart_workflow_archive_rows (table_name,row_json)
        VALUES ${tuples.join(",")}`,values);
      batch.length = 0;batchBytes = 0;
    }
    const reader = createInterface({ input: file.createReadStream({ autoClose: false }),crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        const size = Buffer.byteLength(line);
        bytes += size+1;
        if (bytes > MAX_BYTES || size > MAX_LINE_BYTES || ended)
          throw new Error("Workflow archive exceeds limits or has trailing data.");
        const item = JSON.parse(line) as { type?: unknown;value?: Record<string,unknown> };
        if (item.type === "row") {
          if (!item.value || !nativeTables.includes(item.value.table as Table) || typeof item.value.rowJson !== "string")
            throw new Error("Workflow archive row is invalid.");
          const table = item.value.table as Table,rowJson = item.value.rowJson;
          total++;
          if (total > MAX_ROWS) throw new Error("Workflow archive exceeds its row limit.");
          counts[table]++;
          batch.push({ table,rowJson });batchBytes += size;
          if (batch.length >= MAX_BATCH_ROWS || batchBytes >= MAX_BATCH_BYTES) await flush();
        } else if (item.type === "end") {
          footerHash = typeof item.value?.contentSha256 === "string" ? item.value.contentSha256 : "";
          if (!item.value || item.value.rows !== expected.rows ||
              JSON.stringify(item.value.counts) !== JSON.stringify(counts) || footerHash !== expected.contentSha256 ||
              hash.digest("hex") !== expected.contentSha256)
            throw new Error("Workflow archive changed during erasure.");
          ended = true;
        } else if (item.type !== "manifest") throw new Error("Workflow archive entry is invalid.");
        if (item.type !== "end") hash.update(line+"\n");
      }
    } finally { reader.close(); }
    await flush();
    const after = await file.stat({ bigint: true }),pathAfter = await lstat(resolve(path),{ bigint: true });
    if (!ended || BigInt(bytes) !== before.size || !sameFileVersion(before,after) || !sameFileVersion(before,pathAfter) ||
        total !== expected.rows || JSON.stringify(counts) !== JSON.stringify(expected.counts))
      throw new Error("Workflow archive is incomplete or changed.");
  } finally { await file.close(); }
}

async function assertArchiveRowsMatchLive(db: Client,runIds: string[]) {
  for (const table of nativeTables) {
    const key = table === "workflow_runs" ? "id" : "run_id";
    const result = await db.query<{ matches: boolean }>(`SELECT NOT EXISTS (
      SELECT 1 FROM (
        (SELECT row_json FROM pg_temp.jumpstart_workflow_archive_rows WHERE table_name=$1
          EXCEPT ALL SELECT row_to_json(t)::jsonb FROM workflow.${table} t WHERE t.${key}=ANY($2::text[]))
        UNION ALL
        (SELECT row_to_json(t)::jsonb FROM workflow.${table} t WHERE t.${key}=ANY($2::text[])
          EXCEPT ALL SELECT row_json FROM pg_temp.jumpstart_workflow_archive_rows WHERE table_name=$1)
      ) AS differences
    ) AS matches`,[table,runIds]);
    if (!result.rows[0]?.matches) throw new Error("Current Workflow rows differ from the verified archive.");
  }
}

function selectedJobsSql() {
  return `SELECT jobs.id::text AS id,tasks.identifier AS task_identifier,jobs.locked_by,jobs.payload FROM graphile_worker._private_jobs jobs
    JOIN graphile_worker._private_tasks tasks ON tasks.id=jobs.task_id
    LEFT JOIN graphile_worker._private_job_queues queues ON queues.id=jobs.job_queue_id
    WHERE queues.queue_name=ANY($2::text[]) OR
      (tasks.identifier=ANY($3::text[]) AND jobs.payload->>'runId'=ANY($1::text[]))
    ORDER BY jobs.id LIMIT ${MAX_JOBS+1}`;
}

/** Delete only source-bound, terminal self-hosted PostgreSQL Workflow state. */
export async function eraseAccountWorkflow(source: string,archive: string,ownerInput: AccessOwner,
  workflowUrl: string,jobPrefix: string,execute = false) {
  const owner = accessOwner.parse(ownerInput);
  if (!workflowUrl || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(jobPrefix))
    throw new Error("Invalid Workflow erasure configuration.");
  const expected = await verifyAccountWorkflowExportDetails(source,archive);
  if (expected.format !== "ai-app-jumpstart-workflow-rows-v2" || expected.ownerSha256 !== ownerDigest(owner) ||
      expected.jobPrefix !== jobPrefix)
    throw new Error("Workflow erasure requires a matching owner and source-bound v2 archive.");
  if (Object.values(expected.runStatuses).some(status => !terminalRunStatuses.has(status)))
    throw new Error("Workflow erasure refuses nonterminal runs.");
  if (expected.runIds.length > 100_000 || expected.rows > 200_000 || expected.sessionIds.length > 100_000)
    throw new Error("Workflow archive exceeds erasure limits.");

  const workflowTask = `${jobPrefix}flows`,executorTask = `${workflowTask}_executor`;
  const db = new Client({ connectionString: workflowUrl,connectionTimeoutMillis: 5_000 });
  let connected = false,transactionOpen = false;
  try {
    await db.connect();connected = true;
    await db.query("BEGIN ISOLATION LEVEL READ COMMITTED");transactionOpen = true;
    await db.query("SET LOCAL lock_timeout = '5s'");
    await db.query("SET LOCAL statement_timeout = '60s'");
    const schema = await db.query<{ tablename: string;restricted: boolean }>(`SELECT tablename,
      row_security_active(format('workflow.%I',tablename)::regclass) AS restricted
      FROM pg_tables WHERE schemaname='workflow'`);
    const present = new Map(schema.rows.map(row => [row.tablename,row.restricted]));
    if (nativeTables.some(table => !present.has(table) || present.get(table)) ||
        [...present.keys()].some(table => table.startsWith("workflow_") && !nativeTables.includes(table)))
      throw new Error("Unsupported or restricted Workflow schema.");
    const jobsAccess = await db.query<{ relation: string;restricted: boolean }>(`SELECT relation,
      row_security_active(relation::regclass) AS restricted FROM unnest(ARRAY[
        'graphile_worker._private_jobs','graphile_worker._private_job_queues','graphile_worker._private_tasks'
      ]) AS sources(relation)`);
    if (jobsAccess.rows.length !== 3 || jobsAccess.rows.some(row => row.restricted))
      throw new Error("Backend Workflow job access is required.");
    await db.query(`LOCK TABLE ${nativeTables.map(table => `workflow.${table}`).join(",")},
      graphile_worker._private_jobs,graphile_worker._private_job_queues,graphile_worker._private_tasks
      IN ACCESS EXCLUSIVE MODE`);

    const linkedIds = (await db.query(`${linkedRunsCte} SELECT id FROM linked ORDER BY id`,[expected.sessionIds]))
      .rows.map(row => row.id as string);
    if (!sameValues(linkedIds,expected.runIds))
      throw new Error("Current Workflow run inventory differs from the verified archive.");
    await loadArchiveRows(db,archive,expected);
    await assertArchiveRowsMatchLive(db,expected.runIds);

    const runQueues = expected.runIds.map(id => `${workflowTask}:${id}:executor`);
    const jobs = (await db.query<{ id: string;task_identifier: string;locked_by: string | null;payload: unknown }>(
      selectedJobsSql(),[expected.runIds,runQueues,[workflowTask,executorTask]])).rows;
    if (jobs.length > MAX_JOBS) throw new Error("Workflow job inventory exceeds its limit.");
    if (jobs.some(job => !job.task_identifier.endsWith("flows") && !job.task_identifier.endsWith("flows_executor")))
      throw new Error("A run-linked Graphile job uses an unsupported task.");
    if (jobs.some(job => typeof job.payload === "object" && job.payload !== null &&
        "__healthCheck" in job.payload && job.payload.__healthCheck === true))
      throw new Error("A pending Workflow start check still references a selected run.");
    if (jobs.some(job => job.locked_by !== null)) throw new Error("Workflow workers still hold run-linked jobs.");
    const queues = (await db.query<{ queue_name: string;locked_by: string | null }>(`SELECT queue_name,locked_by
      FROM graphile_worker._private_job_queues WHERE queue_name=ANY($1::text[])`,[runQueues])).rows;
    if (queues.some(queue => queue.locked_by !== null)) throw new Error("Workflow workers still hold run-linked queues.");

    const reverified = await verifyAccountWorkflowExportDetails(source,archive);
    if (reverified.contentSha256 !== expected.contentSha256 || !sameValues(reverified.runIds,expected.runIds))
      throw new Error("Workflow archive changed during erasure.");

    let deletedJobs = 0,deletedQueues = 0,deletedRows = 0;
    if (execute) {
      if (jobs.length) {
        const result = await db.query("DELETE FROM graphile_worker._private_jobs WHERE id=ANY($1::bigint[])",
          [jobs.map(job => job.id)]);
        if (result.rowCount !== jobs.length) throw new Error("Workflow job deletion count differs.");
        deletedJobs = result.rowCount;
      }
      if (queues.length) {
        const result = await db.query("DELETE FROM graphile_worker._private_job_queues WHERE queue_name=ANY($1::text[])",
          [queues.map(queue => queue.queue_name)]);
        if (result.rowCount !== queues.length) throw new Error("Workflow queue deletion count differs.");
        deletedQueues = result.rowCount;
      }
      for (const table of nativeTables.filter(table => table !== "workflow_runs")) {
        const result = await db.query(`DELETE FROM workflow.${table} WHERE run_id=ANY($1::text[])`,[expected.runIds]);
        if (result.rowCount !== expected.counts[table]) throw new Error("Workflow row deletion count differs.");
        deletedRows += result.rowCount ?? 0;
      }
      const runs = await db.query("DELETE FROM workflow.workflow_runs WHERE id=ANY($1::text[])",[expected.runIds]);
      if (runs.rowCount !== expected.counts.workflow_runs) throw new Error("Workflow run deletion count differs.");
      deletedRows += runs.rowCount ?? 0;

      for (const table of nativeTables) {
        const key = table === "workflow_runs" ? "id" : "run_id";
        const remaining = await db.query(`SELECT count(*)::text AS count FROM workflow.${table} WHERE ${key}=ANY($1::text[])`,
          [expected.runIds]);
        if (remaining.rows[0]?.count !== "0") throw new Error("Workflow rows remain after deletion.");
      }
      const linkedRemaining = await db.query(`${linkedRunsCte} SELECT count(*)::text AS count FROM linked`,[expected.sessionIds]);
      if (linkedRemaining.rows[0]?.count !== "0") throw new Error("Linked Workflow runs remain after deletion.");
      const jobsRemaining = await db.query(selectedJobsSql(),[expected.runIds,runQueues,[workflowTask,executorTask]]);
      if (jobsRemaining.rows.length !== 0) throw new Error("Run-linked Workflow jobs remain after deletion.");
      const queuesRemaining = await db.query("SELECT count(*)::text AS count FROM graphile_worker._private_job_queues WHERE queue_name=ANY($1::text[])",
        [runQueues]);
      if (queuesRemaining.rows[0]?.count !== "0") throw new Error("Run-linked Workflow queues remain after deletion.");
      await db.query("COMMIT");transactionOpen = false;
    } else {
      await db.query("ROLLBACK");transactionOpen = false;
    }
    return { workflowProvider: "postgres",runs: expected.runs,rows: expected.rows,
      jobs: jobs.length,queues: queues.length,deletedRows,deletedJobs,deletedQueues,
      status: execute ? "linked-workflow-state-erased" : "linked-workflow-state-erasure-planned",
      scope: `terminal native Workflow rows and run-linked Graphile jobs for ${workflowTask} and ${executorTask}; auxiliary/unlinked runs, external logs, other Workflow worlds, providers, Auth and backups excluded` };
  } catch (error) {
    if (transactionOpen) await db.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { if (connected) await db.end(); }
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:erase:workflow -- --source /private/bundle --archive /private/workflow.ndjson --stopped --plan | --erase-workflow-state --confirm (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT, WORKFLOW_POSTGRES_URL and WORKFLOW_POSTGRES_JOB_PREFIX)";
  const mode = args[5],execute = mode === "--erase-workflow-state";
  if ((args.length !== 6 && args.length !== 7) || args[0] !== "--source" || args[2] !== "--archive" || args[4] !== "--stopped" ||
      !["--plan","--erase-workflow-state"].includes(mode ?? "") || args.length !== (execute ? 7 : 6) ||
      execute && args[6] !== "--confirm" || !args[1] || !args[3] ||
      !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT || !env.WORKFLOW_POSTGRES_URL ||
      !env.WORKFLOW_POSTGRES_JOB_PREFIX) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    console.log(JSON.stringify(await eraseAccountWorkflow(args[1],args[3],
      { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },env.WORKFLOW_POSTGRES_URL,
      env.WORKFLOW_POSTGRES_JOB_PREFIX,execute)));
  } catch {
    console.error("Workflow erasure failed. Check the verified v2 archive, terminal run state, stopped writers and operator access.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main(process.argv.slice(2),process.env);
