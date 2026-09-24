import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { trustedHttpOrigin } from "../security/origin";
import { uploadObjectKey, type PrivateUploadObjects } from "./contract";
import { MAX_UPLOAD_BYTES } from "./validation";

export const SUPABASE_UPLOAD_BUCKET = "app-private-uploads";
const CONTENT_TYPE = "application/octet-stream";
type Storage = SupabaseClient["storage"];

/** Check the bucket on every operation so a changed public setting fails closed. */
export async function verifyPrivateUploadBucket(storage: Storage) {
  const { data, error } = await storage.getBucket(SUPABASE_UPLOAD_BUCKET);
  if (error) throw error;
  if (data.id !== SUPABASE_UPLOAD_BUCKET || data.public !== false ||
      data.file_size_limit !== MAX_UPLOAD_BYTES ||
      data.allowed_mime_types?.length !== 1 || data.allowed_mime_types[0] !== CONTENT_TYPE) {
    throw new Error("Upload bucket must be private, restricted to 5 MiB octet-stream objects.");
  }
}

/** Provision only on an explicit operator command; never change an existing bucket silently. */
export async function provisionPrivateUploadBucket(storage: Storage) {
  const { error } = await storage.getBucket(SUPABASE_UPLOAD_BUCKET);
  if (error?.status === 404) {
    const result = await storage.createBucket(SUPABASE_UPLOAD_BUCKET, {
      public: false, fileSizeLimit: MAX_UPLOAD_BYTES, allowedMimeTypes: [CONTENT_TYPE],
    });
    if (result.error) throw result.error;
  } else if (error) throw error;
  await verifyPrivateUploadBucket(storage);
}

/** This client must stay server-side: its secret key bypasses Storage RLS. */
export function uploadStorageClient(url: string, secret: string) {
  const origin = trustedHttpOrigin(url);
  if (!origin || !secret) throw new Error("A trusted Supabase origin and backend secret are required for upload storage.");
  return createClient(origin, secret, { auth: { persistSession: false, autoRefreshToken: false }, global: {
    fetch: (input, init) => fetch(input, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) }),
  } });
}

/** Private Storage objects remain quarantined until a separate metadata service releases them. */
export function supabaseUploadObjects(storage: Storage): PrivateUploadObjects {
  return {
    async put(owner, id, bytes) {
      const key = uploadObjectKey(owner, id);
      await verifyPrivateUploadBucket(storage);
      const { error } = await storage.from(SUPABASE_UPLOAD_BUCKET).upload(key, Buffer.from(bytes), {
        contentType: CONTENT_TYPE, cacheControl: "0", upsert: false,
      });
      if (error) throw error;
    },
    async get(owner, id) {
      const key = uploadObjectKey(owner, id);
      await verifyPrivateUploadBucket(storage);
      const { data, error } = await storage.from(SUPABASE_UPLOAD_BUCKET).download(key);
      if (error?.status === 404) return null;
      if (error) throw error;
      if (data.size > MAX_UPLOAD_BYTES) throw new Error("Stored upload exceeds the maximum size.");
      return new Uint8Array(await data.arrayBuffer());
    },
    async delete(owner, id) {
      const key = uploadObjectKey(owner, id);
      await verifyPrivateUploadBucket(storage);
      const { data, error } = await storage.from(SUPABASE_UPLOAD_BUCKET).remove([key]);
      if (error) throw error;
      return data.length === 1;
    },
  };
}
