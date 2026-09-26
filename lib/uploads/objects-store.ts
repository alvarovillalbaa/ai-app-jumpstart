import { AppError } from "../http/errors";
import type { PrivateUploadObjects } from "./contract";
import { isAbsolute } from "node:path";

/** Blob backend is explicit and independent of the metadata database choice. */
export async function createUploadObjects(env: Record<string,string | undefined> = process.env): Promise<PrivateUploadObjects> {
  if (env.UPLOAD_STORAGE_PROVIDER === "local") {
    if (!env.UPLOAD_LOCAL_ROOT || !isAbsolute(env.UPLOAD_LOCAL_ROOT) || env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME) {
      throw new AppError(503,"upload_storage_unavailable","Configure a persistent private upload volume for this host.");
    }
    const { localUploadObjects } = await import("./local");
    return localUploadObjects(env.UPLOAD_LOCAL_ROOT);
  }
  if (env.UPLOAD_STORAGE_PROVIDER === "supabase") {
    if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
      throw new AppError(503,"upload_storage_unavailable","Configure a private Supabase Storage backend.");
    }
    const { supabaseUploadObjects,uploadStorageClient } = await import("./supabase");
    return supabaseUploadObjects(uploadStorageClient(env.SUPABASE_URL,env.SUPABASE_SECRET_KEY).storage);
  }
  throw new AppError(503,"upload_storage_unavailable","Configure UPLOAD_STORAGE_PROVIDER before accepting uploads.");
}
