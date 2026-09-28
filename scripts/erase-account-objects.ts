import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { awsS3Settings,awsS3UploadObjects } from "../lib/uploads/aws-s3";
import { localUploadObjects } from "../lib/uploads/local";
import { listLocalOwnerObjectIds,listS3OwnerObjectIds,listSupabaseOwnerObjectIds,readLocalOwnerObject } from "../lib/uploads/object-export";
import { uploadId } from "../lib/uploads/schema";
import { supabaseUploadObjects,uploadStorageClient } from "../lib/uploads/supabase";
import { verifyAccountBundle } from "./export-account-bundle";
import { eraseAccountRows } from "./erase-account-rows";
import { verifyAccountRowExportDetails } from "./export-account-rows";
import { objectSourceSha256 } from "./account-object-source";

type Provider = "local" | "supabase" | "aws-s3";
export type ObjectErasureSource = { list(): Promise<string[]>;get(id: string): Promise<Uint8Array | null>;
  delete(id: string): Promise<boolean> };
const archivedObject = z.object({ id: uploadId,size: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),base64: z.string() }).strict();
const MAX_OBJECTS = 100_000;

async function archiveMetadata(bundlePath: string,expected: number) {
  const objects = new Map<string,{ size: number;sha256: string }>();
  const file = await open(join(resolve(bundlePath),"objects.ndjson"),fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const reader = createInterface({ input: file.createReadStream({ autoClose: false }),crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        const item = z.object({ type: z.string(),value: z.unknown() }).strict().parse(JSON.parse(line));
        if (item.type !== "object") continue;
        const value = archivedObject.parse(item.value);
        if (objects.has(value.id)) throw new Error("Account object bundle repeats a private object ID.");
        objects.set(value.id,{ size: value.size,sha256: value.sha256 });
      }
    } finally { reader.close(); }
  } finally { await file.close(); }
  if (objects.size !== expected) throw new Error("Account object bundle count differs from its verified archive.");
  return objects;
}

function checkedListing(ids: string[]) {
  if (ids.length > MAX_OBJECTS) throw new Error("Account object listing exceeded its limit.");
  for (let index = 0;index < ids.length;index++) {
    if (uploadId.parse(ids[index]) !== ids[index] || index && ids[index-1] >= ids[index])
      throw new Error("Account object listing is not strictly ordered and canonical.");
  }
  return ids;
}

/** Operator-only byte-checked deletion; an interrupted run resumes from the same bundle. */
export async function eraseAccountObjects(source: ObjectErasureSource,provider: Provider,ownerInput: AccessOwner,
  bundlePath: string,env: Record<string,string | undefined>,execute = false,request: typeof fetch = fetch) {
  const owner = accessOwner.parse(ownerInput);
  const bundle = await verifyAccountBundle(bundlePath);
  if (bundle.objectProvider !== provider) throw new Error("Verified bundle does not match the selected object provider.");
  if (!bundle.objectSourceSha256) throw new Error("Private object erasure requires a new source-bound account bundle.");
  if (await objectSourceSha256(provider,env) !== bundle.objectSourceSha256)
    throw new Error("Selected private object source differs from the verified bundle.");
  const rows = await verifyAccountRowExportDetails(join(resolve(bundlePath),"rows.ndjson"));
  if (rows.provider !== bundle.metadataProvider || rows.owner.tenant !== owner.tenant || rows.owner.subject !== owner.subject)
    throw new Error("Verified bundle does not match the selected account owner.");
  // Object erasure precedes row erasure. The existing row plan verifies the
  // permanent fence and ensures no application metadata drifted since capture.
  await eraseAccountRows(bundle.metadataProvider,owner,bundlePath,env,false,request);
  const archived = await archiveMetadata(bundlePath,bundle.objects);
  const current = checkedListing(await source.list());
  for (const id of current) {
    const expected = archived.get(id);
    if (!expected) throw new Error("Current private objects include an unarchived object.");
    const bytes = await source.get(id);
    if (!bytes || bytes.length !== expected.size ||
        createHash("sha256").update(bytes).digest("hex") !== expected.sha256)
      throw new Error("Current private object bytes differ from the verified bundle.");
  }
  if (!execute) return { provider,objects: bundle.objects,remainingBefore: current.length,deleted: 0,
    status: "private-object-erasure-planned",
    scope: "selected owner prefix only; application rows, Auth, Eve/Workflow and external copies remain" };
  let deleted = 0;
  for (const id of current) if (await source.delete(id)) deleted++;
  if (checkedListing(await source.list()).length !== 0)
    throw new Error("Private objects remain after deletion; rerun with the same verified bundle.");
  return { provider,objects: bundle.objects,remainingBefore: current.length,deleted,
    status: "private-objects-erased",
    scope: "selected owner prefix only; application rows, Auth, Eve/Workflow and external copies remain" };
}

export async function eraseSelectedAccountObjects(provider: Provider,owner: AccessOwner,bundlePath: string,
  env: Record<string,string | undefined>,execute = false,request: typeof fetch = fetch) {
  if (provider === "local") {
    if (!env.UPLOAD_LOCAL_ROOT) throw new Error("Private local upload root is required.");
    const root = env.UPLOAD_LOCAL_ROOT,objects = localUploadObjects(root);
    return eraseAccountObjects({ list: () => listLocalOwnerObjectIds(root,owner),
      get: id => readLocalOwnerObject(root,owner,id),delete: id => objects.delete(owner,id) },
    provider,owner,bundlePath,env,execute,request);
  }
  if (provider === "supabase") {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw new Error("Private Supabase Storage settings are required.");
    const storage = uploadStorageClient(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY).storage;
    const objects = supabaseUploadObjects(storage);
    return eraseAccountObjects({ list: () => listSupabaseOwnerObjectIds(storage,owner),
      get: id => objects.get(owner,id),delete: id => objects.delete(owner,id) },
    provider,owner,bundlePath,env,execute,request);
  }
  const { region,bucket } = awsS3Settings(env),client = new S3Client({ region,maxAttempts: 2,ignoreConfiguredEndpointUrls: true });
  try {
    const objects = awsS3UploadObjects(client,bucket);
    return await eraseAccountObjects({ list: () => listS3OwnerObjectIds(client,bucket,owner),
      get: id => objects.get(owner,id),delete: id => objects.delete(owner,id) },
    provider,owner,bundlePath,env,execute,request);
  } finally { client.destroy(); }
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:erase:objects -- --source /private/bundle --stopped --plan|--erase-private-objects (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT, selected metadata backend settings and UPLOAD_STORAGE_PROVIDER with its operator storage settings)";
  if (args.length !== 4 || args[0] !== "--source" || !args[1] || args[2] !== "--stopped" ||
      !["--plan","--erase-private-objects"].includes(args[3]) ||
      !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT ||
      !["local","supabase","aws-s3"].includes(env.UPLOAD_STORAGE_PROVIDER ?? "")) {
    console.error(usage);process.exitCode = 2;return;
  }
  try {
    const result = await eraseSelectedAccountObjects(env.UPLOAD_STORAGE_PROVIDER as Provider,
      { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },args[1],env,
      args[3] === "--erase-private-objects");
    console.log(JSON.stringify(result));
  } catch {
    console.error("Account object erasure failed. Check the verified bundle, row fence, private store and stopped writers; an interrupted execution may have removed some objects.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
