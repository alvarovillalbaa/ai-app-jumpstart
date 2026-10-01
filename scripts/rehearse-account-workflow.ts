import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open,readFile } from "node:fs/promises";
import { dirname,join,resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { z } from "zod";
import { verifyAccountWorkflowExport } from "./export-account-workflow";
import { nativeTables } from "./inspect-account-workflow.mjs";

type Table = typeof nativeTables[number];
const rowEntry = z.object({ type: z.literal("row"),value: z.object({
  table: z.enum(nativeTables),rowJson: z.string(),
}).strict() }).strict();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.resolve("@workflow/world-postgres/cli"))),
  "../src/drizzle/migrations");

async function expectedMigrations() {
  const journal = z.object({ entries: z.array(z.object({ tag: z.string().regex(/^\d+_[a-z0-9_]+$/u),
    when: z.number().int().nonnegative() })) }).parse(JSON.parse(await readFile(
    join(migrationsDirectory,"meta/_journal.json"),"utf8")));
  return Promise.all(journal.entries.map(async entry => ({
    hash: digest(await readFile(join(migrationsDirectory,`${entry.tag}.sql`),"utf8")),
    created_at: String(entry.when),
  })));
}

function disposableTarget(connectionString: string) {
  const url = new URL(connectionString);
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!["postgres:","postgresql:"].includes(url.protocol) ||
      !["127.0.0.1","localhost","[::1]"].includes(url.hostname) || url.search || url.hash ||
      !/^workflow_account_rehearsal_[a-z0-9_]+$/u.test(database))
    throw new Error("Workflow account rehearsal requires a named disposable loopback database.");
}

async function* archiveRows(path: string) {
  const file = await open(path,fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const reader = createInterface({ input: file.createReadStream({ autoClose: false }),crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        const item = JSON.parse(line) as { type?: unknown };
        if (item.type === "row") yield rowEntry.parse(item).value;
      }
    } finally { reader.close(); }
  } finally { await file.close(); }
}

async function assertEmptyTarget(client: Client) {
  const applied = await client.query<{ hash: string;created_at: string }>(`SELECT hash,created_at::text
    FROM workflow_drizzle.workflow_migrations ORDER BY id`);
  if (JSON.stringify(applied.rows) !== JSON.stringify(await expectedMigrations()))
    throw new Error("Workflow account rehearsal target migrations differ.");
  const schema = await client.query<{ tablename: string;restricted: boolean }>(`SELECT tablename,
    row_security_active(format('workflow.%I',tablename)::regclass) AS restricted
    FROM pg_tables WHERE schemaname='workflow'`);
  const present = new Map(schema.rows.map(row => [row.tablename,row.restricted]));
  if (nativeTables.some(table => !present.has(table) || present.get(table)) ||
      [...present.keys()].some(table => table.startsWith("workflow_") && !nativeTables.includes(table)))
    throw new Error("Workflow account rehearsal target schema differs.");
  for (const table of nativeTables) {
    const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM workflow.${table}`);
    if (count.rows[0]?.count !== "0") throw new Error("Workflow account rehearsal target is not empty.");
  }
  const jobs = await client.query<{ restricted: boolean;count: string }>(`SELECT
    row_security_active('graphile_worker.jobs'::regclass) AS restricted,count(*)::text AS count
    FROM graphile_worker.jobs`);
  if (jobs.rows[0]?.restricted || jobs.rows[0]?.count !== "0")
    throw new Error("Workflow account rehearsal target has restricted or pending jobs.");
}

/** Restore an owner archive into a disposable migrated database, compare it, then roll back. */
export async function rehearseAccountWorkflow(source: string,archive: string,targetUrl: string) {
  disposableTarget(targetUrl);
  const expected = await verifyAccountWorkflowExport(source,archive);
  const client = new Client({ connectionString: targetUrl,connectionTimeoutMillis: 5_000 });
  let connected = false,transactionOpen = false;
  try {
    await client.connect();connected = true;
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");transactionOpen = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query(`LOCK TABLE ${nativeTables.map(table => `workflow.${table}`).join(",")},
      graphile_worker.jobs IN ACCESS EXCLUSIVE MODE`);
    await assertEmptyTarget(client);
    const columns = new Map<Table,string[]>(),wanted = new Map<Table,Map<string,number>>();
    let lastTable = -1,restored = 0;
    for await (const row of archiveRows(resolve(archive))) {
      const table = row.table,order = nativeTables.indexOf(table);
      if (order < lastTable) throw new Error("Workflow archive row order differs.");
      lastTable = order;
      let names = columns.get(table);
      if (!names) {
        names = (await client.query<{ attname: string }>(`SELECT attname FROM pg_attribute
          WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum`,[`workflow.${table}`]))
          .rows.map(column => column.attname);
        if (!names.length) throw new Error("Workflow account rehearsal target table is missing.");
        columns.set(table,names);
      }
      const parsed = JSON.parse(row.rowJson) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
          JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify([...names].sort()))
        throw new Error("Workflow archive row differs from the target table shape.");
      const inserted = await client.query(`INSERT INTO workflow.${table}
        SELECT (json_populate_record(NULL::workflow.${table},$1::json)).*`,[row.rowJson]);
      if (inserted.rowCount !== 1) throw new Error("Workflow account rehearsal did not import exactly one row.");
      const hashes = wanted.get(table) ?? new Map<string,number>(),hash = digest(row.rowJson);
      hashes.set(hash,(hashes.get(hash) ?? 0)+1);wanted.set(table,hashes);
      restored++;
    }
    if (restored !== expected.rows) throw new Error("Workflow account rehearsal row count differs.");
    for (const table of nativeTables) {
      const actual = new Map<string,number>();
      await client.query(`DECLARE jumpstart_verify_cursor NO SCROLL CURSOR FOR
        SELECT row_to_json(t)::text AS row_json FROM workflow.${table} t`);
      try {
        while (true) {
          const page = await client.query<{ row_json: string }>("FETCH FORWARD 100 FROM jumpstart_verify_cursor");
          if (!page.rows.length) break;
          for (const row of page.rows) {
            const hash = digest(row.row_json);
            actual.set(hash,(actual.get(hash) ?? 0)+1);
          }
        }
      } finally { await client.query("CLOSE jumpstart_verify_cursor"); }
      const compare = (values: Map<string,number>) => [...values].sort(([a],[b]) => a.localeCompare(b));
      if (JSON.stringify(compare(actual)) !== JSON.stringify(compare(wanted.get(table) ?? new Map())))
        throw new Error("Workflow account rehearsal rows differ from the archive.");
    }
    await verifyAccountWorkflowExport(source,archive);
    await client.query("ROLLBACK");transactionOpen = false;
    await assertEmptyTarget(client);
    return { workflowProvider: "postgres",runs: expected.runs,rows: restored,
      status: "rolled-back-rehearsal" };
  } finally {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => {});
    if (connected) await client.end();
  }
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--archive" ||
      !args[1] || !args[3] || !env.ACCOUNT_REHEARSAL_WORKFLOW_URL) {
    console.error("Usage: npm run account:rehearse:workflow -- --source /private/bundle --archive /private/workflow.ndjson (set ACCOUNT_REHEARSAL_WORKFLOW_URL to an empty migrated loopback workflow_account_rehearsal_* database).");
    process.exitCode = 2;return;
  }
  try { console.log(JSON.stringify(await rehearseAccountWorkflow(args[1],args[3],env.ACCOUNT_REHEARSAL_WORKFLOW_URL))); }
  catch { console.error("Workflow account rehearsal failed. Check the verified archive and isolated current-schema target.");process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
