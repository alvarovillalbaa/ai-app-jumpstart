import { createHash,randomUUID } from "node:crypto";
import { constants as fsConstants,type BigIntStats } from "node:fs";
import { lstat,link,mkdtemp,open,readFile,rm,unlink } from "node:fs/promises";
import { dirname,join,resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { verifyAccountBundle } from "./export-account-bundle";
import { verifyAccountRowExportDetails } from "./export-account-rows";
import { linkedRunsCte,nativeTables } from "./inspect-account-workflow.mjs";

const MAX_SESSIONS = 100_000,MAX_RUNS = 100_000,MAX_ROWS = 200_000;
const MAX_BYTES = 1024 * 1024 * 1024,MAX_LINE_BYTES = 32 * 1024 * 1024;
function sameFileVersion(left: BigIntStats,right: BigIntStats) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
type Table = typeof nativeTables[number];
type Counts = Record<Table,number>;

function safeCount(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Workflow archive count is invalid.");
  return number;
}

function digest(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function ownerDigest(owner: AccessOwner) { return digest(JSON.stringify([owner.tenant,owner.subject])); }

/** The verified application archive is the durable owner-to-session mapping. */
async function sourceSessions(source: string) {
  const bundle = await verifyAccountBundle(source);
  if (!bundle.objectSourceSha256) throw new Error("A source-bound v2 account bundle is required.");
  const rows = await verifyAccountRowExportDetails(join(resolve(source),"rows.ndjson"));
  const owner = accessOwner.parse(rows.owner);
  const manifestSha256 = digest(await readFile(join(resolve(source),"manifest.json")));
  const ids = new Set<string>();
  const file = await open(join(resolve(source),"rows.ndjson"),fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const reader = createInterface({ input: file.createReadStream({ autoClose: false }),crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        const item = JSON.parse(line) as { type?: string;value?: { entity?: string;rowJson?: string } };
        if (item.type !== "row" || item.value?.entity !== "conversations") continue;
        const conversation = JSON.parse(item.value.rowJson ?? "null") as Record<string,unknown> | null;
        const id = conversation?.[rows.provider === "convex" ? "sessionId" : "session_id"];
        if (id === null) continue;
        if (typeof id !== "string" || id.length < 1 || id.length > 512 || ids.has(id))
          throw new Error("Account bundle has an invalid session binding.");
        ids.add(id);
        if (ids.size > MAX_SESSIONS) throw new Error("Account bundle exceeds the session limit.");
      }
    } finally { reader.close(); }
  } finally { await file.close(); }
  return { owner,ids: [...ids],manifestSha256 };
}

function emptyCounts(tables: string[] = nativeTables): Counts {
  return Object.fromEntries(tables.map(table => [table,0])) as Counts;
}

function linked(id: string,attributes: Record<string,unknown>,known: Set<string>) {
  return known.has(id) || typeof attributes["$eve.root"] === "string" && known.has(attributes["$eve.root"]) ||
    typeof attributes["$eve.parent"] === "string" && known.has(attributes["$eve.parent"]);
}

/** Offline integrity, source binding and owner-lineage verification. No database credentials. */
export async function verifyAccountWorkflowExport(source: string,archive: string) {
  const sourceData = await sourceSessions(source);
  const path = resolve(archive);
  const file = await open(path,fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    const pathBefore = await lstat(path,{ bigint: true });
    if (!sameFileVersion(before,pathBefore) || (before.mode & BigInt(0o077)) !== BigInt(0) ||
        before.size < BigInt(1) || before.size > BigInt(MAX_BYTES)) throw new Error("Workflow archive is unsafe or changed.");
    const hash = createHash("sha256"),runs = new Map<string,Record<string,unknown>>();
    let archiveTables: string[] = [...nativeTables],counts = emptyCounts();
    const childRunIds: string[] = [];
    let header = false,ended = false,bytes = 0,total = 0;
    const reader = createInterface({ input: file.createReadStream({ autoClose: false }),crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        bytes += Buffer.byteLength(line)+1;
        if (bytes > MAX_BYTES || Buffer.byteLength(line) > MAX_LINE_BYTES || ended)
          throw new Error("Workflow archive exceeds its limits or has trailing data.");
        const item = JSON.parse(line) as { type?: string;value?: Record<string,unknown> };
        if (item.type === "manifest") {
          if (header || !item.value || !["ai-app-jumpstart-workflow-rows-v1","ai-app-jumpstart-workflow-rows-v2"].includes(String(item.value.format)) ||
              item.value.workflowProvider !== "postgres" || item.value.sourceManifestSha256 !== sourceData.manifestSha256 ||
              item.value.ownerSha256 !== ownerDigest(sourceData.owner) || item.value.boundSessionCount !== sourceData.ids.length)
            throw new Error("Workflow archive source does not match its account bundle.");
          archiveTables = item.value.format === "ai-app-jumpstart-workflow-rows-v1"
            ? nativeTables.filter(table => table !== "workflow_invocations") : [...nativeTables];
          counts = emptyCounts(archiveTables);
          header = true;
        } else if (item.type === "row") {
          if (!header || !item.value || !archiveTables.includes(item.value.table as string) ||
              typeof item.value.rowJson !== "string") throw new Error("Workflow archive has an invalid row.");
          const table = item.value.table as Table;
          const row = JSON.parse(item.value.rowJson) as Record<string,unknown>;
          if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("Workflow row is invalid.");
          if (table === "workflow_runs") {
            if (typeof row.id !== "string" || runs.has(row.id) || !row.attributes ||
                typeof row.attributes !== "object" || Array.isArray(row.attributes))
              throw new Error("Workflow run identity is invalid.");
            runs.set(row.id,row.attributes as Record<string,unknown>);
            if (runs.size > MAX_RUNS) throw new Error("Workflow archive exceeds the run limit.");
          } else {
            if (typeof row.run_id !== "string") throw new Error("Workflow child identity is invalid.");
            childRunIds.push(row.run_id);
          }
          counts[table] = safeCount((counts[table] ?? 0)+1);
          total = safeCount(total+1);
          if (total > MAX_ROWS) throw new Error("Workflow archive exceeds the row limit.");
        } else if (item.type === "end") {
          if (!header || !item.value || item.value.rows !== total ||
              JSON.stringify(item.value.counts) !== JSON.stringify(counts) ||
              item.value.contentSha256 !== hash.digest("hex"))
            throw new Error("Workflow archive digest or counts differ.");
          ended = true;
        } else throw new Error("Workflow archive has an unknown entry.");
        if (item.type !== "end") hash.update(line+"\n");
      }
    } finally { reader.close(); }
    const after = await file.stat({ bigint: true });
    const pathAfter = await lstat(path,{ bigint: true });
    if (!header || !ended || BigInt(bytes) !== before.size || !sameFileVersion(before,after) ||
        !sameFileVersion(before,pathAfter))
      throw new Error("Workflow archive is incomplete or changed.");
    const known = new Set(sourceData.ids);
    let previous = -1;
    while (previous !== known.size) {
      previous = known.size;
      for (const [id,attributes] of runs) if (linked(id,attributes,known)) known.add(id);
    }
    if ([...runs.keys()].some(id => !known.has(id)) || childRunIds.some(id => !runs.has(id)))
      throw new Error("Workflow archive contains unlinked rows.");
    return { runs: counts.workflow_runs ?? 0,rows: total,counts: { ...emptyCounts(),...counts },
      sourceManifestSha256: sourceData.manifestSha256 };
  } finally { await file.close(); }
}

/** Capture native PostgreSQL Workflow rows traceable to a verified account bundle. */
export async function exportAccountWorkflow(source: string,output: string,workflowUrl: string,ownerInput: AccessOwner) {
  const sourceData = await sourceSessions(source),owner = accessOwner.parse(ownerInput);
  if (owner.tenant !== sourceData.owner.tenant || owner.subject !== sourceData.owner.subject || !workflowUrl ||
      !output || output.includes("\u0000")) throw new Error("Workflow export configuration does not match the account bundle.");
  const destination = resolve(output),parent = dirname(destination),details = await lstat(parent);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
    throw new Error("Workflow archive needs a private real parent directory.");
  const db = new Client({ connectionString: workflowUrl,connectionTimeoutMillis: 5_000 });
  await db.connect();
  let directory: string | undefined,file: Awaited<ReturnType<typeof open>> | undefined,published = false;
  try {
    directory = await mkdtemp(join(parent,".jumpstart-workflow-export-"));
    const temporary = join(directory,randomUUID()+".ndjson");
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await db.query("SET LOCAL statement_timeout = '30s'");
    const schema = await db.query(`SELECT tablename,row_security_active(format('workflow.%I',tablename)::regclass) AS restricted
      FROM pg_tables WHERE schemaname='workflow'`);
    const present = new Map(schema.rows.map(row => [row.tablename,row.restricted]));
    if (nativeTables.some(table => !present.has(table) || present.get(table)) ||
        [...present.keys()].some(table => table.startsWith("workflow_") && !nativeTables.includes(table)))
      throw new Error("Unsupported or restricted Workflow schema.");
    const jobsAccess = await db.query("SELECT row_security_active('graphile_worker.jobs'::regclass) AS restricted");
    if (jobsAccess.rows[0].restricted) throw new Error("Backend Workflow job access is required.");
    const jobs = await db.query("SELECT count(*) AS count FROM graphile_worker.jobs WHERE locked_by IS NOT NULL");
    if (safeCount(jobs.rows[0].count) !== 0) throw new Error("Workflow workers still hold jobs.");
    const linkedIds = (await db.query(`${linkedRunsCte} SELECT id FROM linked ORDER BY id`,[sourceData.ids])).rows
      .map(row => row.id as unknown);
    if (linkedIds.length > MAX_RUNS || linkedIds.some(id => typeof id !== "string" || !id || id.length > 512))
      throw new Error("Workflow run inventory exceeds its limit.");
    const ids = linkedIds as string[];
    const expected = emptyCounts(),actual = emptyCounts();
    for (const table of nativeTables) {
      const key = table === "workflow_runs" ? "id" : "run_id";
      expected[table] = safeCount((await db.query(`SELECT count(*) AS count FROM workflow.${table} WHERE ${key}=ANY($1::text[])`,[ids])).rows[0].count);
    }
    file = await open(temporary,"wx",0o600);
    const hash = createHash("sha256");
    let bytes = 0,total = 0;
    async function write(type: string,value: unknown) {
      if (!file) throw new Error("Workflow archive file is unavailable.");
      const line = JSON.stringify({ type,value })+"\n",size = Buffer.byteLength(line);
      if (size > MAX_LINE_BYTES || (bytes += size) > MAX_BYTES)
        throw new Error("Workflow archive exceeds its byte limit.");
      if (type !== "end") hash.update(line);
      await file.writeFile(line);
    }
    await write("manifest",{ format: "ai-app-jumpstart-workflow-rows-v2",workflowProvider: "postgres",
      sourceManifestSha256: sourceData.manifestSha256,ownerSha256: ownerDigest(owner),
      boundSessionCount: sourceData.ids.length,exportedAt: new Date().toISOString(),
      scope: "linked native Workflow rows in one read snapshot under operator-attested stopped writers; unlinked auxiliary runs, Graphile jobs, managed/local worlds, Auth, providers and backups excluded" });
    for (const table of nativeTables) {
      const key = table === "workflow_runs" ? "id" : "run_id";
      let offset = 0;
      while (offset < expected[table]) {
        const page = await db.query(`SELECT row_to_json(t)::text AS row_json FROM workflow.${table} t
          WHERE t.${key}=ANY($1::text[]) ORDER BY t.ctid LIMIT 25 OFFSET $2`,[ids,offset]);
        if (!page.rows.length) throw new Error("Workflow archive row count changed during capture.");
        for (const row of page.rows) {
          if (typeof row.row_json !== "string") throw new Error("Workflow row JSON is unavailable.");
          await write("row",{ table,rowJson: row.row_json });
          actual[table] = safeCount(actual[table]+1);
          total = safeCount(total+1);
          if (total > MAX_ROWS) throw new Error("Workflow archive exceeds the row limit.");
        }
        offset += page.rows.length;
      }
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Workflow archive counts differ.");
    await write("end",{ counts: actual,rows: total,contentSha256: hash.digest("hex") });
    await file.sync();await file.close();file = undefined;
    await db.query("COMMIT");
    await verifyAccountBundle(source);
    await link(temporary,destination);published = true;
    const verified = await verifyAccountWorkflowExport(source,destination);
    return { runs: verified.runs,rows: verified.rows,counts: verified.counts,
      scope: "linked PostgreSQL Workflow rows only; source-bound forensic archive, not a complete account export or erasure certificate" };
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {});
    if (published) await unlink(destination).catch(() => {});
    throw error;
  } finally { await file?.close();await db.end();if (directory) await rm(directory,{ recursive: true,force: true }); }
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:export:workflow -- --source /private/bundle --output /private/new.ndjson --stopped (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT and WORKFLOW_POSTGRES_URL); or npm run account:verify:workflow -- --source /private/bundle --archive /private/workflow.ndjson";
  if (args.length === 4 && args[0] === "--source" && args[2] === "--archive") {
    try { console.log(JSON.stringify(await verifyAccountWorkflowExport(args[1],args[3]))); }
    catch { console.error("Workflow archive verification failed.");process.exitCode = 1; }
    return;
  }
  if (args.length !== 5 || args[0] !== "--source" || args[2] !== "--output" || args[4] !== "--stopped" ||
      !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT || !env.WORKFLOW_POSTGRES_URL) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    console.log(JSON.stringify(await exportAccountWorkflow(args[1],args[3],env.WORKFLOW_POSTGRES_URL,
      { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT })));
  } catch {
    console.error("Workflow export failed. Check the verified account bundle, stopped writers, private destination and backend access.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
