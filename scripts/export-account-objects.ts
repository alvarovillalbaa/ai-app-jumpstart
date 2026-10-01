import { createHash,randomUUID } from "node:crypto";
import { lstat,link,mkdtemp,open,rm } from "node:fs/promises";
import { dirname,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import type { AccessOwner } from "../lib/agent-access/contract";
import { awsS3Settings,awsS3UploadObjects } from "../lib/uploads/aws-s3";
import { uploadId } from "../lib/uploads/schema";
import { listLocalOwnerObjectIds,listS3OwnerObjectIds,listSupabaseOwnerObjectIds,readLocalOwnerObject } from "../lib/uploads/object-export";
import { supabaseUploadObjects,uploadStorageClient } from "../lib/uploads/supabase";
import { MAX_UPLOAD_BYTES } from "../lib/uploads/validation";

type Provider = "local" | "supabase" | "aws-s3";
export type ObjectExportSource = { list(): Promise<string[]>;get(id: string): Promise<Uint8Array | null> };

/** Export raw quarantined objects, including catalog orphans. This does not release them to an app user. */
export async function exportAccountObjects(source: ObjectExportSource,output: string,provider: Provider,owner?: AccessOwner) {
  if (!output || output.includes("\u0000")) throw new Error("Provide an output file.");
  const destination = resolve(output),parent = dirname(destination),details = await lstat(parent);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
    throw new Error("Export destination parent must be a private real directory.");
  const ids = await source.list();
  if (ids.length > 100_000) throw new Error("Private object export exceeded its object limit.");
  for (let index = 0;index < ids.length;index++) {
    uploadId.parse(ids[index]);
    if (index && ids[index-1] >= ids[index]) throw new Error("Private object listing is not strictly ordered.");
  }
  const directory = await mkdtemp(join(parent,".jumpstart-object-export-"));
  const temporary = join(directory,`${randomUUID()}.ndjson`);
  const digest = createHash("sha256");
  let file: Awaited<ReturnType<typeof open>> | undefined;
  async function write(type: string,value: unknown) {
    if (!file) throw new Error("Export file is unavailable.");
    const line = `${JSON.stringify({ type,value })}\n`;
    if (type !== "end") digest.update(line);
    await file.writeFile(line);
  }
  try {
    file = await open(temporary,"wx",0o600);
    await write("manifest",{
      format: "ai-app-jumpstart-private-objects-v1",provider,exportedAt: new Date().toISOString(),
      ...(owner ? { ownerSha256: createHash("sha256").update(JSON.stringify([owner.tenant,owner.subject])).digest("hex") } : {}),
      consistency: "operator-attested stopped writers; listings before and after export must match; not a transaction or durable write fence",
      exclusions: "Application metadata, Auth, Eve/Workflow, object versions, unfinished multipart uploads, derived copies, logs and backups",
    });
    for (const id of ids) {
      const bytes = await source.get(id);
      if (!bytes || bytes.length < 1 || bytes.length > MAX_UPLOAD_BYTES)
        throw new Error("Private object disappeared or has an unsupported size.");
      await write("object",{ id,size: bytes.length,sha256: createHash("sha256").update(bytes).digest("hex"),base64: Buffer.from(bytes).toString("base64") });
    }
    const after = await source.list();
    if (after.length !== ids.length || after.some((id,index) => id !== ids[index]))
      throw new Error("Private object listing changed during export.");
    await write("end",{ counts: { objects: ids.length },contentSha256: digest.digest("hex") });
    await file.sync();
    await file.close();file = undefined;
    // A hard link publishes only the complete, synced file and cannot replace an existing export.
    await link(temporary,destination);
    return { objects: ids.length };
  } finally {
    await file?.close();
    await rm(directory,{ recursive: true,force: true });
  }
}

export async function exportSelectedAccountObjects(provider: Provider,owner: AccessOwner,output: string,env: Record<string,string | undefined>) {
  if (provider === "local") {
    if (!env.UPLOAD_LOCAL_ROOT) throw new Error("Private local upload root is required.");
    const root = env.UPLOAD_LOCAL_ROOT;
    return exportAccountObjects({ list: () => listLocalOwnerObjectIds(root,owner),
      get: id => readLocalOwnerObject(root,owner,id) },output,provider,owner);
  }
  if (provider === "supabase") {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw new Error("Private Supabase Storage settings are required.");
    const storage = uploadStorageClient(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY).storage,
      objects = supabaseUploadObjects(storage);
    return exportAccountObjects({ list: () => listSupabaseOwnerObjectIds(storage,owner),
      get: id => objects.get(owner,id) },output,provider,owner);
  }
  const { region,bucket } = awsS3Settings(env),client = new S3Client({ region,maxAttempts: 2,ignoreConfiguredEndpointUrls: true });
  try {
    const objects = awsS3UploadObjects(client,bucket);
    return await exportAccountObjects({ list: () => listS3OwnerObjectIds(client,bucket,owner),
      get: id => objects.get(owner,id) },output,provider,owner);
  } finally { client.destroy(); }
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:export:objects -- --output /private/new.ndjson --stopped (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT and UPLOAD_STORAGE_PROVIDER with its backend settings in the process environment)";
  if (args.length !== 3 || args[0] !== "--output" || !args[1] || args[2] !== "--stopped" ||
      !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT ||
      !["local","supabase","aws-s3"].includes(env.UPLOAD_STORAGE_PROVIDER ?? "")) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    const result = await exportSelectedAccountObjects(env.UPLOAD_STORAGE_PROVIDER as Provider,
      { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },args[1],env);
    console.log(JSON.stringify(result));
  } catch {
    console.error("Account object export failed. Check the private store, destination and stopped-writer state.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
