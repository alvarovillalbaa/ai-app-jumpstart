import { createHash,randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { constants as fsConstants,type BigIntStats } from "node:fs";
import { lstat,link,mkdtemp,open,rm } from "node:fs/promises";
import { dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { Client } from "pg";
import { z } from "zod";
import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { sqliteFencedTables } from "../lib/account-closure/sqlite-fences";
import { accountDataInventory,accountOrphanCountQueries,accountOwnerCountQueries,accountOwnerRowQueries,
  readAccountSchemaSources,verifyAccountDataInventory } from "./account-data-inventory.mjs";
import { inspectConvexAccountData } from "./inspect-convex-account-data";

type Provider = "sqlite" | "postgres" | "convex";
type RawRow = { entity: string;rowJson: string };
type Source = { provider: Provider;counts: Record<string,number>;consistency: string;
  rows(): AsyncGenerator<RawRow>;verify(): Promise<void>;close(): Promise<void> };
const MAX_ROWS = 100_000,MAX_BYTES = 512 * 1024 * 1024,MAX_ROW_BYTES = 2 * 1024 * 1024;
const MAX_ROW_LINE_BYTES = MAX_ROW_BYTES * 2 + 4096;
const MAX_CONVEX_PAGES = 10_000;
function sameFileVersion(left: BigIntStats,right: BigIntStats) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
const DIRECT_ENTITIES = new Set(allRows().filter(entry => entry.owner === "direct").map(entry => entry.entity));
const rowPage = z.object({ rows: z.array(z.record(z.string(),z.unknown())).max(10),
  orphans: z.number().int().nonnegative(),scanned: z.number().int().min(0).max(10),
  done: z.boolean(),cursor: z.string().nullable() }).strict();

function count(value: unknown) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Account row export count is invalid.");
  return number;
}

function allRows() {
  return accountDataInventory.filter(entry => entry.owner !== "global-expiring" && entry.owner !== "closure-control");
}

export function sqliteRowJson(row: Record<string,unknown>) {
  // Keep every int64 exact. Node's default SQLite conversion can round large integers.
  return JSON.stringify(row,(_key,value: unknown) => typeof value === "bigint"
    ? { $sqliteInt64: value.toString() } : value instanceof Uint8Array
      ? { $sqliteBlobBase64: Buffer.from(value).toString("base64") } : value);
}

async function openSqlite(path: string,owner: AccessOwner): Promise<Source> {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) throw new Error("A real initialized SQLite database is required.");
  const db = new DatabaseSync(path,{ readOnly: true,timeout: 5_000 });
  try {
    db.exec("BEGIN");
    const covered = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(row => String(row.name)));
    if (sqliteFencedTables.some(table => !covered.has(table+"_account_fence_insert") ||
        !covered.has(table+"_account_fence_update"))) throw new Error("SQLite account write-fence guards are incomplete.");
    if (!db.prepare("SELECT 1 FROM app_account_fences WHERE tenant=? AND subject=?").get(owner.tenant,owner.subject))
      throw new Error("Account rows must be permanently fenced before export.");
    for (const query of accountOrphanCountQueries("sqlite"))
      if (count(db.prepare(query.sql).get()?.count) !== 0) throw new Error("Unattributable application rows require investigation.");
    const counts = Object.fromEntries(accountOwnerCountQueries("sqlite").map(query =>
      [query.entity,count(db.prepare(query.sql).get(owner.tenant,owner.subject)?.count)]));
    return { provider: "sqlite",counts,consistency: "one read transaction after a permanent row fence; stopped writers attested",
      async *rows() {
        for (const query of accountOwnerRowQueries("sqlite")) {
          const statement = db.prepare(query.sql);
          statement.setReadBigInts(true);
          for (const row of statement.iterate(owner.tenant,owner.subject))
            yield { entity: query.entity,rowJson: sqliteRowJson(row) };
        }
      },
      async verify() {},
      async close() { if (db.isTransaction) db.exec("ROLLBACK");db.close(); } };
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK");db.close();throw error; }
}

async function openPostgres(connectionString: string,owner: AccessOwner): Promise<Source> {
  const client = new Client({ connectionString,connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    const tables = accountDataInventory.filter(entry => entry.sql && entry.owner !== "closure-control").map(entry => entry.sql);
    const access = await client.query("SELECT row_security_active(format('public.%I',table_name)::regclass) AS restricted FROM unnest($1::text[]) AS names(table_name)",[tables]);
    if (access.rows.some(row => row.restricted)) throw new Error("Account row export requires backend table access.");
    const triggerResult = await client.query("SELECT c.relname,t.tgtype,t.tgenabled,p.proname,fn.nspname AS function_schema FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace fn ON fn.oid=p.pronamespace WHERE n.nspname='public' AND t.tgname='app_account_fence_write' AND NOT t.tgisinternal");
    const guarded = new Map(triggerResult.rows.map(row => [row.relname,row]));
    if (allRows().some(entry => { if (!entry.sql) return false;const trigger = guarded.get(entry.sql);return !trigger ||
      (Number(trigger.tgtype) & 23) !== 23 || !["O","A"].includes(trigger.tgenabled) ||
      trigger.proname !== "account_fence_guard_write" ||
      trigger.function_schema !== "app_private"; }))
      throw new Error("PostgreSQL account write-fence guards are incomplete.");
    if (!(await client.query("SELECT 1 FROM app_private.account_fences WHERE tenant=$1 AND subject=$2",[owner.tenant,owner.subject])).rowCount)
      throw new Error("Account rows must be permanently fenced before export.");
    for (const query of accountOrphanCountQueries("sql"))
      if (count((await client.query(query.sql)).rows[0]?.count) !== 0) throw new Error("Unattributable application rows require investigation.");
    const counts: Record<string,number> = {};
    for (const query of accountOwnerCountQueries("sql"))
      counts[query.entity] = count((await client.query(query.sql,[owner.tenant,owner.subject])).rows[0]?.count);
    return { provider: "postgres",counts,consistency: "one repeatable-read transaction after a permanent row fence; stopped writers attested",
      async *rows() {
        for (const query of accountOwnerRowQueries("sql")) {
          let offset = 0;
          while (true) {
            const batch = await client.query(query.sql+" LIMIT $3 OFFSET $4",[owner.tenant,owner.subject,25,offset]);
            for (const row of batch.rows) {
              if (typeof row.row_json !== "string") throw new Error("PostgreSQL row JSON is unavailable.");
              yield { entity: query.entity,rowJson: row.row_json };
            }
            offset += batch.rows.length;
            if (batch.rows.length < 25) break;
          }
        }
      },
      async verify() {},
      async close() { await client.query("ROLLBACK").catch(() => {});await client.end(); } };
  } catch (error) { await client.query("ROLLBACK").catch(() => {});await client.end();throw error; }
}

function convexEndpoint(siteUrl: string,secret: string) {
  const url = new URL(siteUrl);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname)) ||
      secret.length < 32 || secret.length > 512) throw new Error("Invalid Convex operator configuration.");
  return new URL("/app/audit",url);
}

async function openConvex(siteUrl: string,secret: string,owner: AccessOwner,request: typeof fetch): Promise<Source> {
  const endpoint = convexEndpoint(siteUrl,secret);
  async function audit(payload: Record<string,unknown>) {
    const response = await request(endpoint,{ method: "POST",redirect: "error",signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json","x-jumpstart-audit-key": secret },body: JSON.stringify({ ...payload,...owner }) });
    if (!response.ok) throw new Error("Convex account export request failed.");
    return response.json() as Promise<unknown>;
  }
  async function fenced() {
    const status = z.object({ fenced: z.boolean() }).strict().parse(await audit({ operation: "accountFenceStatus" }));
    if (!status.fenced) throw new Error("Account rows must be permanently fenced before export.");
  }
  await fenced();
  const before = await inspectConvexAccountData(siteUrl,secret,owner.tenant,owner.subject,request);
  if (before.orphanRowTotal !== 0) throw new Error("Unattributable application rows require investigation.");
  return { provider: "convex",counts: before.ownerRows,
    consistency: "bounded Convex read pages after a permanent row fence; stopped writers attested",
    async *rows() {
      let pages = 0;
      for (const entry of allRows().filter(item => item.convex)) {
        let cursor: string | null = null;
        do {
          if (++pages > MAX_CONVEX_PAGES) throw new Error("Convex account export exceeded its page limit.");
          const result = rowPage.parse(await audit({ operation: "accountRowPage",entity: entry.convex,cursor }));
          if (result.done !== (result.cursor === null) || !result.done && (!result.scanned || result.cursor === cursor) ||
              result.rows.length + result.orphans > result.scanned || entry.owner === "direct" && result.orphans !== 0)
            throw new Error("Convex account export returned an invalid page.");
          if (result.orphans) throw new Error("Unattributable application rows require investigation.");
          for (const row of result.rows) {
            if (entry.owner === "direct" && (row.tenant !== owner.tenant || row.subject !== owner.subject))
              throw new Error("Convex account export returned a foreign row.");
            yield { entity: entry.entity,rowJson: JSON.stringify(row) };
          }
          cursor = result.cursor;
        } while (cursor !== null);
      }
    },
    async verify() {
      await fenced();
      const after = await inspectConvexAccountData(siteUrl,secret,owner.tenant,owner.subject,request);
      if (after.orphanRowTotal !== 0 || JSON.stringify(after.ownerRows) !== JSON.stringify(before.ownerRows))
        throw new Error("Convex account rows changed during export.");
    },
    async close() {} };
}

/** Publish only an exact, private, digest-bearing account row snapshot. */
export async function exportAccountRows(source: Source,ownerInput: AccessOwner,output: string) {
  const owner = accessOwner.parse(ownerInput);
  if (!output || output.includes("\u0000")) throw new Error("Provide an output file.");
  const destination = resolve(output),parent = dirname(destination),details = await lstat(parent);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
    throw new Error("Export destination parent must be a private real directory.");
  const expected = Object.keys(source.counts);
  const classified = allRows().filter(entry => entry[source.provider === "postgres" ? "sql" : source.provider])
    .map(entry => entry.entity);
  if (JSON.stringify(expected) !== JSON.stringify(classified))
    throw new Error("Account row export inventory is incomplete.");
  const directory = await mkdtemp(resolve(parent,".jumpstart-row-export-"));
  const temporary = resolve(directory,randomUUID()+".ndjson");
  const digest = createHash("sha256"),counts = Object.fromEntries(expected.map(entity => [entity,0])) as Record<string,number>;
  let file: Awaited<ReturnType<typeof open>> | undefined,bytes = 0,rows = 0;
  async function write(type: string,value: unknown) {
    if (!file) throw new Error("Account row export file is unavailable.");
    const line = JSON.stringify({ type,value })+"\n";
    if (Buffer.byteLength(line) > MAX_ROW_LINE_BYTES) throw new Error("Account row export exceeded its line limit.");
    bytes += Buffer.byteLength(line);
    if (bytes > MAX_BYTES) throw new Error("Account row export exceeded its byte limit.");
    if (type !== "end") digest.update(line);
    await file.writeFile(line);
  }
  try {
    file = await open(temporary,"wx",0o600);
    await write("manifest",{ format: "ai-app-jumpstart-application-rows-v1",provider: source.provider,
      owner,exportedAt: new Date().toISOString(),consistency: source.consistency,
      exclusions: "Private object bytes, global nonces, Auth, Eve/Workflow, provider copies, logs and backups" });
    for await (const row of source.rows()) {
      if (!(row.entity in counts) || typeof row.rowJson !== "string" ||
          Buffer.byteLength(row.rowJson) > MAX_ROW_BYTES)
        throw new Error("Account row export returned an invalid row.");
      const parsed = z.record(z.string(),z.unknown()).safeParse(JSON.parse(row.rowJson));
      if (!parsed.success || DIRECT_ENTITIES.has(row.entity) &&
          (parsed.data.tenant !== owner.tenant || parsed.data.subject !== owner.subject))
        throw new Error("Account row export returned an invalid owner row.");
      counts[row.entity] = count(counts[row.entity]+1);
      rows = count(rows+1);
      if (rows > MAX_ROWS) throw new Error("Account row export exceeded its row limit.");
      await write("row",row);
    }
    if (expected.some(entity => counts[entity] !== source.counts[entity]))
      throw new Error("Account row export count changed during capture.");
    await source.verify();
    await write("end",{ counts,rows,contentSha256: digest.digest("hex") });
    await file.sync();await file.close();file = undefined;
    await link(temporary,destination);
    return { provider: source.provider,rows };
  } finally { await file?.close();await rm(directory,{ recursive: true,force: true }); }
}

export async function exportSelectedAccountRows(provider: Provider,owner: AccessOwner,output: string,
  env: Record<string,string | undefined>,request: typeof fetch = fetch) {
  verifyAccountDataInventory(readAccountSchemaSources());
  const checked = accessOwner.parse(owner);
  const source = provider === "sqlite" ? await openSqlite(env.ACCOUNT_AUDIT_SQLITE_PATH ?? "",checked)
    : provider === "postgres" ? await openPostgres(env.DATABASE_URL ?? "",checked)
    : await openConvex(env.CONVEX_SITE_URL ?? "",env.CONVEX_AUDIT_SECRET ?? "",checked,request);
  try { return await exportAccountRows(source,checked,output); }
  finally { await source.close(); }
}

/** Offline integrity verification; this deliberately has no backend credentials or network path. */
export async function verifyAccountRowExportDetails(path: string) {
  const file = await open(path,fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const actual = await file.stat({ bigint: true });
    const pathDetails = await lstat(path,{ bigint: true });
    if (!sameFileVersion(actual,pathDetails) || (actual.mode & BigInt(0o077)) !== BigInt(0) ||
        actual.size < BigInt(1) || actual.size > BigInt(MAX_BYTES)) throw new Error("Account row export file is unsafe or changed.");
    const finalByte = Buffer.alloc(1);
    if ((await file.read(finalByte,0,1,Number(actual.size-BigInt(1)))).bytesRead !== 1 || finalByte[0] !== 10)
      throw new Error("Account row export file is incomplete.");
    const digest = createHash("sha256"),reader = createInterface({ input: file.createReadStream({ autoClose: false }),crlfDelay: Infinity });
    let manifest: { provider: Provider;owner: AccessOwner } | null = null,ended = false,rows = 0,bytes = 0;
    let counts: Record<string,number> = {};
    try {
      for await (const line of reader) {
        bytes += Buffer.byteLength(line)+1;
        if (bytes > MAX_BYTES || Buffer.byteLength(line) > MAX_ROW_LINE_BYTES)
          throw new Error("Account row export exceeded its size limit.");
        if (ended) throw new Error("Account row export has trailing data.");
        const item = z.object({ type: z.enum(["manifest","row","end"]),value: z.unknown() }).strict().parse(JSON.parse(line));
        if (item.type === "manifest") {
          if (manifest) throw new Error("Account row export has a duplicate manifest.");
          const value = z.object({ format: z.literal("ai-app-jumpstart-application-rows-v1"),
            provider: z.enum(["sqlite","postgres","convex"]),owner: accessOwner,exportedAt: z.string(),consistency: z.string(),
            exclusions: z.string() }).strict().parse(item.value);
          manifest = value;
          counts = Object.fromEntries(allRows().filter(entry => entry[value.provider === "postgres" ? "sql" : value.provider])
            .map(entry => [entry.entity,0]));
        } else if (item.type === "row") {
          if (!manifest) throw new Error("Account row export has no manifest.");
          const value = z.object({ entity: z.string(),rowJson: z.string().max(MAX_ROW_BYTES) }).strict().parse(item.value);
          const parsed = z.record(z.string(),z.unknown()).safeParse(JSON.parse(value.rowJson));
          if (!(value.entity in counts) || !parsed.success || DIRECT_ENTITIES.has(value.entity) &&
              (parsed.data.tenant !== manifest.owner.tenant || parsed.data.subject !== manifest.owner.subject))
            throw new Error("Account row export contains an unknown or invalid row.");
          counts[value.entity] = count(counts[value.entity]+1);
          rows = count(rows+1);
          if (rows > MAX_ROWS) throw new Error("Account row export exceeded its row limit.");
        } else {
          if (!manifest) throw new Error("Account row export has no manifest.");
          const value = z.object({ counts: z.record(z.string(),z.number().int().nonnegative()),
            rows: z.number().int().nonnegative(),contentSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().parse(item.value);
          if (value.rows !== rows || JSON.stringify(value.counts) !== JSON.stringify(counts) ||
              value.contentSha256 !== digest.digest("hex")) throw new Error("Account row export digest or counts differ.");
          ended = true;
        }
        if (item.type !== "end") digest.update(line+"\n");
      }
    } finally { reader.close(); }
    const final = await file.stat({ bigint: true });
    const pathFinal = await lstat(path,{ bigint: true });
    if (!manifest || !ended || BigInt(bytes) !== actual.size || !sameFileVersion(actual,final) ||
        !sameFileVersion(actual,pathFinal))
      throw new Error("Account row export is incomplete or changed during verification.");
    return { provider: manifest.provider,owner: manifest.owner,counts,rows };
  } finally { await file.close(); }
}

export async function verifyAccountRowExport(path: string) {
  const { provider,rows } = await verifyAccountRowExportDetails(path);
  return { provider,rows };
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:export:rows -- --metadata sqlite|postgres|convex --output /private/new.ndjson --stopped (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT and selected operator backend settings in the environment); or npm run account:verify:rows -- /private/export.ndjson";
  if (args.length === 2 && args[0] === "--verify") {
    try { console.log(JSON.stringify(await verifyAccountRowExport(args[1]))); }
    catch { console.error("Account row export verification failed.");process.exitCode = 1; }
    return;
  }
  if (args.length !== 5 || args[0] !== "--metadata" || !["sqlite","postgres","convex"].includes(args[1]) ||
      args[2] !== "--output" || !args[3] || args[4] !== "--stopped" || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    const result = await exportSelectedAccountRows(args[1] as Provider,
      { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },args[3],env);
    console.log(JSON.stringify(result));
  } catch {
    console.error("Account row export failed. Check fence, orphan rows, private destination, permissions and stopped writers.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
