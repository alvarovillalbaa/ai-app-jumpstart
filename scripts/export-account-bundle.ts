import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat,link,mkdir,open,readdir,realpath,rm,unlink } from "node:fs/promises";
import { basename,dirname,join,relative,resolve,sep } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { uploadId } from "../lib/uploads/schema";
import { exportSelectedAccountObjects } from "./export-account-objects";
import { exportSelectedAccountRows,verifyAccountRowExport } from "./export-account-rows";
import { verifyExport } from "./verify-export";

type MetadataProvider = "sqlite" | "postgres" | "convex";
type ObjectProvider = "local" | "supabase" | "aws-s3";
const ROWS = "rows.ndjson",OBJECTS = "objects.ndjson",MANIFEST = "manifest.json";
const archiveNames = [ROWS,OBJECTS] as const;
const fileSchema = z.object({ name: z.enum(archiveNames),bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const catalogSchema = z.object({ catalogRows: z.number().int().nonnegative(),
  activeRows: z.number().int().nonnegative(),objectOrphans: z.number().int().nonnegative(),
  transitionalWithoutBytes: z.number().int().nonnegative() }).strict();
const bundleSchema = z.object({ format: z.literal("ai-app-jumpstart-account-bundle-v1"),version: z.literal(1),
  createdAt: z.string(),metadataProvider: z.enum(["sqlite","postgres","convex"]),
  objectProvider: z.enum(["local","supabase","aws-s3"]),
  ownerSha256: z.string().regex(/^[a-f0-9]{64}$/u),rows: z.number().int().nonnegative(),
  objects: z.number().int().nonnegative(),catalog: catalogSchema,
  files: z.tuple([fileSchema,fileSchema]),consistency: z.string(),exclusions: z.string() }).strict();

function ownerHash(owner: AccessOwner) {
  return createHash("sha256").update(JSON.stringify([owner.tenant,owner.subject])).digest("hex");
}

async function privateFile(path: string) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0 || details.size < 1)
    throw new Error("Account bundle has an unsafe archive.");
  return details;
}

async function describeFile(root: string,name: typeof archiveNames[number]) {
  const path = join(root,name),details = await privateFile(path);
  const file = await open(path,fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (before.ino !== details.ino || before.size !== details.size || (before.mode & 0o077) !== 0)
      throw new Error("Account bundle archive changed.");
    const digest = createHash("sha256");
    for await (const chunk of file.createReadStream({ autoClose: false })) digest.update(chunk);
    const after = await file.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("Account bundle archive changed during hashing.");
    return { name,bytes: before.size,sha256: digest.digest("hex") };
  } finally { await file.close(); }
}

async function* lines(path: string): AsyncGenerator<{ type: string;value: unknown }> {
  const file = await open(path,fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const reader = createInterface({ input: file.createReadStream({ autoClose: false }),crlfDelay: Infinity });
    try {
      for await (const line of reader) yield z.object({ type: z.string(),value: z.unknown() }).strict().parse(JSON.parse(line));
    } finally { reader.close(); }
  } finally { await file.close(); }
}

function uploadSize(value: unknown) {
  const number = typeof value === "number" ? value
    : typeof value === "object" && value !== null && "$sqliteInt64" in value &&
      typeof value.$sqliteInt64 === "string" && /^\d+$/u.test(value.$sqliteInt64)
      ? Number(value.$sqliteInt64) : NaN;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("Account bundle upload size is invalid.");
  return number;
}

/** Check the relation after both independently verified archives have been read. */
async function inspectArchives(root: string) {
  let owner: AccessOwner | null = null,metadataProvider: MetadataProvider | null = null;
  const catalog = new Map<string,{ state: string;sha256: string;size: number }>();
  for await (const line of lines(join(root,ROWS))) {
    if (line.type === "manifest") {
      const header = z.object({ provider: z.enum(["sqlite","postgres","convex"]),owner: accessOwner }).passthrough().parse(line.value);
      owner = header.owner;metadataProvider = header.provider;
    }
    if (line.type !== "row") continue;
    const value = z.object({ entity: z.string(),rowJson: z.string() }).strict().parse(line.value);
    if (value.entity !== "uploads") continue;
    const row = z.object({ id: z.string(),state: z.enum(["pending","quarantined","clean","rejected","deleting","deleted"]),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u),size: z.unknown() }).passthrough().parse(JSON.parse(value.rowJson));
    const id = uploadId.parse(row.id);
    if (catalog.has(id)) throw new Error("Account bundle repeats an upload catalog ID.");
    catalog.set(id,{ state: row.state,sha256: row.sha256,size: uploadSize(row.size) });
  }
  if (!owner || !metadataProvider) throw new Error("Account bundle has no row owner.");
  let objectProvider: ObjectProvider | null = null,objectOwnerSha256: string | null = null;
  const objects = new Map<string,{ sha256: string;size: number }>();
  for await (const line of lines(join(root,OBJECTS))) {
    if (line.type === "manifest") {
      const header = z.object({ provider: z.enum(["local","supabase","aws-s3"]),
        ownerSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).passthrough().parse(line.value);
      objectProvider = header.provider;objectOwnerSha256 = header.ownerSha256;
    }
    if (line.type !== "object") continue;
    const value = z.object({ id: z.string(),sha256: z.string().regex(/^[a-f0-9]{64}$/u),
      size: z.number().int().positive() }).passthrough().parse(line.value);
    const id = uploadId.parse(value.id);
    if (objects.has(id)) throw new Error("Account bundle repeats an object ID.");
    objects.set(id,{ sha256: value.sha256,size: value.size });
  }
  if (!objectProvider || objectOwnerSha256 !== ownerHash(owner))
    throw new Error("Account bundle object namespace does not match its row owner.");
  let activeRows = 0,transitionalWithoutBytes = 0;
  for (const [id,row] of catalog) {
    const object = objects.get(id),active = ["quarantined","clean","rejected"].includes(row.state);
    if (active) activeRows++;
    if (object && (object.sha256 !== row.sha256 || object.size !== row.size))
      throw new Error("Account bundle object differs from its catalog row.");
    if (!object && active) throw new Error("Account bundle is missing bytes for an active upload.");
    if (!object && !active) transitionalWithoutBytes++;
  }
  const objectOrphans = [...objects.keys()].filter(id => !catalog.has(id)).length;
  return { owner,metadataProvider,objectProvider,objects: objects.size,
    catalog: { catalogRows: catalog.size,activeRows,objectOrphans,transitionalWithoutBytes } };
}

/** Offline verification of both formats, file hashes, owner binding and catalog-to-byte consistency. */
export async function verifyAccountBundle(directory: string) {
  const root = resolve(directory),details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
    throw new Error("Account bundle requires a private real directory.");
  if (JSON.stringify((await readdir(root)).sort()) !== JSON.stringify([MANIFEST,OBJECTS,ROWS].sort()))
    throw new Error("Account bundle has missing or unexpected files.");
  const manifestDetails = await privateFile(join(root,MANIFEST));
  if (manifestDetails.size > 65536) throw new Error("Account bundle manifest is too large.");
  const handle = await open(join(root,MANIFEST),fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let manifest;
  try {
    const before = await handle.stat();
    if (before.ino !== manifestDetails.ino || before.size !== manifestDetails.size || (before.mode & 0o077) !== 0)
      throw new Error("Account bundle manifest changed.");
    manifest = bundleSchema.parse(JSON.parse(await handle.readFile("utf8")));
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("Account bundle manifest changed during verification.");
  }
  finally { await handle.close(); }
  if (manifest.files[0].name !== ROWS || manifest.files[1].name !== OBJECTS)
    throw new Error("Account bundle file order is invalid.");
  const files = await Promise.all(archiveNames.map(name => describeFile(root,name)));
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error("Account bundle archive hashes or sizes differ.");
  const rows = await verifyAccountRowExport(join(root,ROWS));
  const objects = await verifyExport(join(root,OBJECTS));
  if (objects.mode !== "private-objects" || rows.rows !== manifest.rows ||
      objects.counts.objects !== manifest.objects)
    throw new Error("Account bundle archive counts differ.");
  const relation = await inspectArchives(root);
  if (rows.provider !== manifest.metadataProvider || relation.metadataProvider !== manifest.metadataProvider ||
      relation.objectProvider !== manifest.objectProvider || relation.objects !== manifest.objects ||
      ownerHash(relation.owner) !== manifest.ownerSha256 ||
      JSON.stringify(relation.catalog) !== JSON.stringify(manifest.catalog))
    throw new Error("Account bundle owner or catalog relation differs.");
  return { metadataProvider: manifest.metadataProvider,objectProvider: manifest.objectProvider,
    rows: rows.rows,objects: manifest.objects,catalog: manifest.catalog };
}

/** A directory is complete only after its last-published manifest exists and verifies. */
export async function exportAccountBundle(metadataProvider: MetadataProvider,objectProvider: ObjectProvider,
  ownerInput: AccessOwner,output: string,env: Record<string,string | undefined>,request: typeof fetch = fetch) {
  const owner = accessOwner.parse(ownerInput);
  if (!output || output.includes("\u0000")) throw new Error("Provide a new account bundle directory.");
  const destination = resolve(output),parent = dirname(destination),details = await lstat(parent);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
    throw new Error("Account bundle parent must be a private real directory.");
  if (objectProvider === "local" && env.UPLOAD_LOCAL_ROOT) {
    const source = await realpath(env.UPLOAD_LOCAL_ROOT);
    const canonicalDestination = join(await realpath(parent),basename(destination));
    const path = relative(source,canonicalDestination);
    if (path === "" || path !== ".." && !path.startsWith(".."+sep) && !path.startsWith(sep))
      throw new Error("Account bundle cannot be written inside its object source.");
  }
  await mkdir(destination,{ mode: 0o700 });
  let complete = false;
  try {
    const rowResult = await exportSelectedAccountRows(metadataProvider,owner,join(destination,ROWS),env,request);
    const objectResult = await exportSelectedAccountObjects(objectProvider,owner,join(destination,OBJECTS),env);
    await verifyAccountRowExport(join(destination,ROWS));
    await verifyExport(join(destination,OBJECTS));
    const relation = await inspectArchives(destination);
    if (relation.metadataProvider !== metadataProvider || relation.objectProvider !== objectProvider ||
        relation.objects !== objectResult.objects || ownerHash(relation.owner) !== ownerHash(owner))
      throw new Error("Account bundle sources do not match.");
    const files = await Promise.all(archiveNames.map(name => describeFile(destination,name)));
    const manifest = { format: "ai-app-jumpstart-account-bundle-v1",version: 1,
      createdAt: new Date().toISOString(),metadataProvider,objectProvider,ownerSha256: ownerHash(owner),
      rows: rowResult.rows,objects: objectResult.objects,catalog: relation.catalog,files,
      consistency: "permanent application-row fence and operator-attested stopped writers; sequential metadata and object reads, not a cross-service transaction",
      exclusions: "Auth, Eve/Workflow, external/provider copies, object versions, unfinished uploads, derived copies, logs and backups" };
    const temporary = join(destination,".manifest.tmp"),file = await open(temporary,"wx",0o600);
    try { await file.writeFile(JSON.stringify(manifest)+"\n");await file.sync(); }
    finally { await file.close(); }
    await link(temporary,join(destination,MANIFEST));
    await unlink(temporary);
    const verified = await verifyAccountBundle(destination);
    complete = true;
    return verified;
  } finally { if (!complete) await rm(destination,{ recursive: true,force: true }); }
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:export:bundle -- --metadata sqlite|postgres|convex --output /private/new-dir --stopped (set account identity, metadata and UPLOAD_STORAGE_PROVIDER settings in the operator environment); or npm run account:verify:bundle -- /private/dir";
  if (args.length === 2 && args[0] === "--verify") {
    try { console.log(JSON.stringify(await verifyAccountBundle(args[1]))); }
    catch { console.error("Account bundle verification failed.");process.exitCode = 1; }
    return;
  }
  if (args.length !== 5 || args[0] !== "--metadata" || !["sqlite","postgres","convex"].includes(args[1]) ||
      args[2] !== "--output" || !args[3] || args[4] !== "--stopped" ||
      !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT ||
      !["local","supabase","aws-s3"].includes(env.UPLOAD_STORAGE_PROVIDER ?? "")) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    console.log(JSON.stringify(await exportAccountBundle(args[1] as MetadataProvider,
      env.UPLOAD_STORAGE_PROVIDER as ObjectProvider,
      { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },args[3],env)));
  } catch {
    console.error("Account bundle export failed. Check fence, stopped writers, private stores and destination.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
