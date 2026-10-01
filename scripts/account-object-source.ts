import { createHash } from "node:crypto";
import { lstat,realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { awsS3Settings } from "../lib/uploads/aws-s3";
import { SUPABASE_UPLOAD_BUCKET } from "../lib/uploads/supabase";
import { trustedHttpOrigin } from "../lib/security/origin";

type Provider = "local" | "supabase" | "aws-s3";

/** A private bundle binds deletion to the source selected at export time. */
export async function objectSourceSha256(provider: Provider,env: Record<string,string | undefined>) {
  let parts: string[];
  if (provider === "local") {
    const root = env.UPLOAD_LOCAL_ROOT;
    if (!root || !isAbsolute(root)) throw new Error("A private absolute local upload root is required.");
    const details = await lstat(root,{ bigint: true });
    if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & BigInt(0o77)) !== BigInt(0))
      throw new Error("Local upload source must be a private real directory.");
    parts = [await realpath(root),String(details.dev),String(details.ino)];
  } else if (provider === "supabase") {
    const origin = trustedHttpOrigin(env.SUPABASE_URL);
    if (!origin) throw new Error("A trusted Supabase Storage origin is required.");
    parts = [origin,SUPABASE_UPLOAD_BUCKET];
  } else {
    const { region,bucket } = awsS3Settings(env);
    parts = [region,bucket];
  }
  return createHash("sha256").update(JSON.stringify(["ai-app-jumpstart-object-source-v1",provider,...parts])).digest("hex");
}
