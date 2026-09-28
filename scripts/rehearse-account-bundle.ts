import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { lstat,link,mkdir,open,readFile,readdir,realpath,rm,unlink,chmod } from "node:fs/promises";
import { basename,dirname,isAbsolute,join,relative,resolve,sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { sqliteAccessStore } from "../lib/agent-access/sqlite";
import { sqliteFencedTables } from "../lib/account-closure/sqlite-fences";
import { sqliteBudgetStore } from "../lib/budgets/sqlite";
import { SqliteRepository } from "../lib/data/sqlite";
import { sqlitePreferenceStore } from "../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../lib/request-limits/sqlite";
import { localUploadObjects } from "../lib/uploads/local";
import { listLocalOwnerObjectIds,readLocalOwnerObject } from "../lib/uploads/object-export";
import { uploadId } from "../lib/uploads/schema";
import { sqliteUploadCatalog } from "../lib/uploads/catalog-sqlite";
import { accountDataInventory,accountOwnerRowQueries } from "./account-data-inventory.mjs";
import { verifyAccountBundle } from "./export-account-bundle";
import { sqliteRowJson } from "./export-account-rows";
import { setSqliteAccountFence } from "./fence-account-writes";

const format = "ai-app-jumpstart-sqlite-account-rehearsal-v1";
const marker = "manifest.json";
const ownerHash = (owner: AccessOwner) => createHash("sha256")
  .update(JSON.stringify([owner.tenant,owner.subject])).digest("hex");
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const restoredManifest = z.object({ format: z.literal(format),version: z.literal(1),createdAt: z.string(),
  sourceManifestSha256: sha,ownerSha256: sha,rows: z.number().int().nonnegative(),
  objects: z.number().int().nonnegative(),scope: z.literal("isolated SQLite application rows and local objects; account remains fenced") }).strict();
const archiveLine = z.object({ type: z.string(),value: z.unknown() }).strict();
const archiveRow = z.object({ entity: z.string(),rowJson: z.string() }).strict();
const archiveObject = z.object({ id: uploadId,sha256: sha,size: z.number().int().positive(),base64: z.string() }).strict();
const tables = new Map(accountDataInventory.filter(entry => entry.sqlite &&
  entry.owner !== "global-expiring" && entry.owner !== "closure-control").map(entry => [entry.entity,entry.sqlite]));

function inside(parent: string,child: string) {
  const path = relative(parent,child);
  return path === "" || path !== ".." && !path.startsWith(".."+sep) && !isAbsolute(path);
}

async function privateDirectory(path: string) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
    throw new Error("Account rehearsal requires a private real directory.");
}

async function privateFile(path: string,maxBytes: number) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0 ||
      details.size < 1 || details.size > maxBytes)
    throw new Error("Account rehearsal has an unsafe file.");
}

async function* lines(path: string): AsyncGenerator<z.infer<typeof archiveLine>> {
  const file = await open(path,fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const reader = createInterface({ input: file.createReadStream({ autoClose: false }),crlfDelay: Infinity });
    try { for await (const line of reader) yield archiveLine.parse(JSON.parse(line)); }
    finally { reader.close(); }
  } finally { await file.close(); }
}

async function archiveOwner(source: string) {
  for await (const item of lines(join(source,"rows.ndjson"))) {
    if (item.type !== "manifest") throw new Error("Account rehearsal archive has no owner.");
    return z.object({ owner: accessOwner }).passthrough().parse(item.value).owner;
  }
  throw new Error("Account rehearsal archive is empty.");
}

function sqliteValue(value: unknown): string | number | bigint | Uint8Array | null {
  if (value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Account rehearsal row has an unsupported SQLite value.");
  const fields = Object.keys(value as object);
  if (fields.length !== 1) throw new Error("Account rehearsal row has an unsupported SQLite tag.");
  if (fields[0] === "$sqliteInt64") {
    const text = (value as { $sqliteInt64: unknown }).$sqliteInt64;
    if (typeof text !== "string" || !/^-?(?:0|[1-9]\d*)$/u.test(text)) throw new Error("Account rehearsal has an invalid int64.");
    const number = BigInt(text);
    const bound = BigInt(1) << BigInt(63);
    if (number < -bound || number > bound-BigInt(1)) throw new Error("Account rehearsal int64 is out of range.");
    return number;
  }
  if (fields[0] === "$sqliteBlobBase64") {
    const text = (value as { $sqliteBlobBase64: unknown }).$sqliteBlobBase64;
    if (typeof text !== "string") throw new Error("Account rehearsal has an invalid blob.");
    const bytes = Buffer.from(text,"base64");
    if (bytes.toString("base64") !== text) throw new Error("Account rehearsal has an invalid blob.");
    return bytes;
  }
  throw new Error("Account rehearsal row has an unsupported SQLite tag.");
}

function canonical(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Account rehearsal row is invalid.");
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left],[right]) => left.localeCompare(right))));
}

function rowFingerprint(rowJson: string) {
  return createHash("sha256").update(canonical(JSON.parse(rowJson))).digest("hex");
}

async function initializeSqlite(path: string) {
  for (const initialize of [() => new SqliteRepository(path),() => sqliteAccessStore(path),
    () => sqliteBudgetStore(path),() => sqliteUploadCatalog(path),() => sqlitePreferenceStore(path),
    () => sqliteRequestLimitStore(path)]) await initialize().close();
}

async function importRows(source: string,path: string) {
  const db = new DatabaseSync(path);
  let rows = 0;
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const statements = new Map<string,{ columns: string[];statement: ReturnType<DatabaseSync["prepare"]> }>();
    for await (const item of lines(join(source,"rows.ndjson"))) {
      if (item.type !== "row") continue;
      const { entity,rowJson } = archiveRow.parse(item.value),table = tables.get(entity);
      if (!table) throw new Error("Account rehearsal contains an unsupported entity.");
      let entry = statements.get(entity);
      if (!entry) {
        const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
        if (!columns.length) throw new Error("Account rehearsal target schema is incomplete.");
        const identifiers = columns.map(name => `"${name.replaceAll('"','""')}"`).join(",");
        entry = { columns,statement: db.prepare(`INSERT INTO ${table} (${identifiers}) VALUES (${columns.map(() => "?").join(",")})`) };
        statements.set(entity,entry);
      }
      const row = z.record(z.string(),z.unknown()).parse(JSON.parse(rowJson));
      if (Object.keys(row).sort().join("\n") !== [...entry.columns].sort().join("\n"))
        throw new Error("Account rehearsal archive does not match the current SQLite schema.");
      entry.statement.run(...entry.columns.map(column => sqliteValue(row[column])));
      rows++;
    }
    db.exec("COMMIT");
  } catch (error) { if (db.isTransaction) db.exec("ROLLBACK");throw error; }
  finally { db.close(); }
  return rows;
}

async function restoreObjects(source: string,root: string,owner: AccessOwner) {
  await mkdir(root,{ mode: 0o700 });
  const objects = localUploadObjects(root);
  let count = 0;
  for await (const item of lines(join(source,"objects.ndjson"))) {
    if (item.type !== "object") continue;
    const object = archiveObject.parse(item.value);
    const bytes = Buffer.from(object.base64,"base64");
    if (bytes.length !== object.size || bytes.toString("base64") !== object.base64 ||
        createHash("sha256").update(bytes).digest("hex") !== object.sha256)
      throw new Error("Account rehearsal object differs from the bundle.");
    await objects.put(owner,object.id,bytes);
    count++;
  }
  return count;
}

async function compareRows(source: string,path: string,owner: AccessOwner) {
  const expected = new Map<string,string[]>();
  for await (const item of lines(join(source,"rows.ndjson"))) {
    if (item.type !== "row") continue;
    const row = archiveRow.parse(item.value),hashes = expected.get(row.entity) ?? [];
    hashes.push(rowFingerprint(row.rowJson));expected.set(row.entity,hashes);
  }
  const db = new DatabaseSync(path,{ readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").all() as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0].integrity_check !== "ok" ||
        db.prepare("PRAGMA foreign_key_check").all().length !== 0 ||
        !db.prepare("SELECT 1 FROM app_account_fences WHERE tenant=? AND subject=?").get(owner.tenant,owner.subject))
      throw new Error("Account rehearsal target is not intact and fenced.");
    const fences = db.prepare("SELECT tenant,subject FROM app_account_fences").all();
    const triggers = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[])
      .map(row => row.name));
    if (fences.length !== 1 || fences[0].tenant !== owner.tenant || fences[0].subject !== owner.subject ||
        (db.prepare("SELECT count(*) AS count FROM app_internal_nonces").get() as { count: number }).count !== 0 ||
        !triggers.has("app_account_fences_no_update") || !triggers.has("app_account_fences_no_delete") ||
        sqliteFencedTables.some(table => !triggers.has(table+"_account_fence_insert") ||
          !triggers.has(table+"_account_fence_update")))
      throw new Error("Account rehearsal target control state or fence guards differ.");
    let rows = 0;
    for (const query of accountOwnerRowQueries("sqlite")) {
      const statement = db.prepare(query.sql);statement.setReadBigInts(true);
      const actual: string[] = [];
      for (const row of statement.iterate(owner.tenant,owner.subject))
        actual.push(rowFingerprint(sqliteRowJson(row)));
      actual.sort();
      const wanted = (expected.get(query.entity) ?? []).sort();
      const table = tables.get(query.entity)!;
      const total = db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number };
      if (total.count !== actual.length)
        throw new Error("Account rehearsal target contains foreign application rows.");
      if (JSON.stringify(actual) !== JSON.stringify(wanted))
        throw new Error("Account rehearsal restored rows differ from the bundle.");
      rows += actual.length;
    }
    return rows;
  } finally { db.close(); }
}

async function compareObjects(source: string,root: string,owner: AccessOwner) {
  const expected = new Map<string,{ size: number;sha256: string }>();
  for await (const item of lines(join(source,"objects.ndjson"))) {
    if (item.type !== "object") continue;
    const object = archiveObject.parse(item.value);
    expected.set(object.id,{ size: object.size,sha256: object.sha256 });
  }
  const ids = await listLocalOwnerObjectIds(root,owner);
  if (JSON.stringify(ids) !== JSON.stringify([...expected.keys()].sort()))
    throw new Error("Account rehearsal restored object IDs differ from the bundle.");
  for (const id of ids) {
    const bytes = await readLocalOwnerObject(root,owner,id),wanted = expected.get(id)!;
    if (!bytes || bytes.length !== wanted.size || createHash("sha256").update(bytes).digest("hex") !== wanted.sha256)
      throw new Error("Account rehearsal restored object bytes differ from the bundle.");
  }
  return ids.length;
}

/** Compare a fresh, fenced SQLite/local rehearsal to every source row and object. */
export async function verifyRehearsedAccountBundle(sourceInput: string,outputInput: string) {
  const source = resolve(sourceInput),output = resolve(outputInput);
  const bundle = await verifyAccountBundle(source);
  if (bundle.metadataProvider !== "sqlite" || bundle.objectProvider !== "local")
    throw new Error("Account rehearsal requires a SQLite/local bundle.");
  await privateDirectory(output);
  if (JSON.stringify((await readdir(output)).sort()) !== JSON.stringify(["app.sqlite",marker,"uploads"].sort()))
    throw new Error("Account rehearsal has missing or unexpected files.");
  await privateFile(join(output,"app.sqlite"),2*1024*1024*1024);
  await privateFile(join(output,marker),65536);
  await privateDirectory(join(output,"uploads"));
  const manifest = restoredManifest.parse(JSON.parse(await readFile(join(output,marker),"utf8")));
  const owner = await archiveOwner(source);
  const sourceManifestSha256 = createHash("sha256").update(await readFile(join(source,marker))).digest("hex");
  if (manifest.sourceManifestSha256 !== sourceManifestSha256 || manifest.ownerSha256 !== ownerHash(owner) ||
      manifest.rows !== bundle.rows || manifest.objects !== bundle.objects)
    throw new Error("Account rehearsal manifest differs from the source bundle.");
  const rows = await compareRows(source,join(output,"app.sqlite"),owner);
  const objects = await compareObjects(source,join(output,"uploads"),owner);
  if (rows !== bundle.rows || objects !== bundle.objects)
    throw new Error("Account rehearsal counts differ from the source bundle.");
  return { provider: "sqlite",rows,objects,status: "fenced-rehearsal" };
}

/** Recover only to a new isolated directory. No existing application or object store is touched. */
export async function rehearseAccountBundle(sourceInput: string,outputInput: string) {
  const source = await realpath(resolve(sourceInput)),bundle = await verifyAccountBundle(source);
  if (bundle.metadataProvider !== "sqlite" || bundle.objectProvider !== "local")
    throw new Error("Account rehearsal requires a SQLite/local bundle.");
  const destination = resolve(outputInput),parent = dirname(destination);
  await privateDirectory(parent);
  const output = join(await realpath(parent),basename(destination));
  if (inside(source,output)) throw new Error("Account rehearsal output must be outside the bundle.");
  await mkdir(output,{ mode: 0o700 });
  let complete = false;
  try {
    const owner = await archiveOwner(source),database = join(output,"app.sqlite");
    await initializeSqlite(database);
    const rows = await importRows(source,database);
    const objects = await restoreObjects(source,join(output,"uploads"),owner);
    if (rows !== bundle.rows || objects !== bundle.objects)
      throw new Error("Account rehearsal imported counts differ from the bundle.");
    setSqliteAccountFence(database,owner);
    const db = new DatabaseSync(database);
    try { db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE"); }
    finally { db.close(); }
    await chmod(database,0o600);
    const databaseFile = await open(database,"r");
    try { await databaseFile.sync(); }
    finally { await databaseFile.close(); }
    await verifyAccountBundle(source);
    await compareRows(source,database,owner);
    await compareObjects(source,join(output,"uploads"),owner);
    const manifest = restoredManifest.parse({ format,version: 1,createdAt: new Date().toISOString(),
      sourceManifestSha256: createHash("sha256").update(await readFile(join(source,marker))).digest("hex"),
      ownerSha256: ownerHash(owner),rows,objects,
      scope: "isolated SQLite application rows and local objects; account remains fenced" });
    const temporary = join(output,".manifest.tmp"),file = await open(temporary,"wx",0o600);
    try { await file.writeFile(JSON.stringify(manifest)+"\n");await file.sync(); }
    finally { await file.close(); }
    await link(temporary,join(output,marker));await unlink(temporary);
    const result = await verifyRehearsedAccountBundle(source,output);
    complete = true;
    return result;
  } finally { if (!complete) await rm(output,{ recursive: true,force: true }); }
}

async function main(args: string[]) {
  const usage = "Usage: npm run account:rehearse:bundle -- --source /private/bundle --output /private/new-rehearsal; or npm run account:verify:rehearsal -- /private/bundle /private/rehearsal";
  if (args.length === 3 && args[0] === "--verify") {
    try { console.log(JSON.stringify(await verifyRehearsedAccountBundle(args[1],args[2]))); }
    catch { console.error("Account rehearsal verification failed.");process.exitCode = 1; }
    return;
  }
  if (args.length !== 4 || args[0] !== "--source" || !args[1] || args[2] !== "--output" || !args[3]) {
    console.error(usage);process.exitCode = 2;return;
  }
  try { console.log(JSON.stringify(await rehearseAccountBundle(args[1],args[3]))); }
  catch { console.error("Account rehearsal failed. Check source integrity, private destination and target schema.");process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2));
