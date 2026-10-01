import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { S3Client } from "@aws-sdk/client-s3";
import { awsS3Settings } from "../lib/uploads/aws-s3";
import { inspectLocalOwnerObjects,inspectS3OwnerObjects,inspectSupabaseOwnerObjects } from "../lib/uploads/object-inventory";
import { uploadStorageClient } from "../lib/uploads/supabase";

type Provider = "local" | "supabase" | "aws-s3";

/** Operator-only observation; does not read bytes or modify object storage. */
export async function inspectAccountObjects(provider: Provider,owner: { tenant: string;subject: string },env: Record<string,string | undefined>) {
  if (!owner.tenant || !owner.subject) throw new Error("An account owner is required.");
  let objectCount: number;
  if (provider === "local") {
    if (!env.UPLOAD_LOCAL_ROOT) throw new Error("A local upload root is required.");
    objectCount = await inspectLocalOwnerObjects(env.UPLOAD_LOCAL_ROOT,owner);
  } else if (provider === "supabase") {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) throw new Error("Supabase Storage configuration is required.");
    objectCount = await inspectSupabaseOwnerObjects(uploadStorageClient(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY).storage,owner);
  } else {
    const { region,bucket } = awsS3Settings(env),client = new S3Client({ region,maxAttempts: 2,ignoreConfiguredEndpointUrls: true });
    try { objectCount = await inspectS3OwnerObjects(client,bucket,owner); }
    finally { client.destroy(); }
  }
  return { format: "ai-app-jumpstart-account-object-inspection-v1",provider,objectCount,
    scope: "one owner namespace; paged or local listing without a write fence, object versions, multipart uploads, other stores or backups" };
}

async function main(args: string[],env: NodeJS.ProcessEnv) {
  const usage = "Usage: npm run account:inspect:objects -- --read-only (set ACCOUNT_AUDIT_TENANT, ACCOUNT_AUDIT_SUBJECT and UPLOAD_STORAGE_PROVIDER with its backend settings in the process environment)";
  if (args.length !== 1 || args[0] !== "--read-only" || !env.ACCOUNT_AUDIT_TENANT || !env.ACCOUNT_AUDIT_SUBJECT ||
      !["local","supabase","aws-s3"].includes(env.UPLOAD_STORAGE_PROVIDER ?? "")) {
    console.error(usage);process.exitCode = 2;return;
  }
  try { console.log(JSON.stringify(await inspectAccountObjects(env.UPLOAD_STORAGE_PROVIDER as Provider,
    { tenant: env.ACCOUNT_AUDIT_TENANT,subject: env.ACCOUNT_AUDIT_SUBJECT },env),null,2)); }
  catch { console.error("Account object inspection failed. Check the private store, permissions and configuration.");process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2),process.env);
