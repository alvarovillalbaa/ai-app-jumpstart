import { lstat,readdir } from "node:fs/promises";
import { isAbsolute,join,resolve } from "node:path";
import { ListObjectsV2Command,type S3Client } from "@aws-sdk/client-s3";
import type { AccessOwner } from "../agent-access/contract";
import { uploadOwnerPrefix } from "./contract";
import { verifyPrivateS3Bucket } from "./aws-s3";
import { SUPABASE_UPLOAD_BUCKET,verifyPrivateUploadBucket,type uploadStorageClient } from "./supabase";

const MAX_PAGES = 10_000;

/** Counts files under one opaque owner directory. Missing owner directories are empty. */
export async function inspectLocalOwnerObjects(root: string,owner: AccessOwner) {
  if (!isAbsolute(root)) throw new Error("An absolute private upload root is required.");
  const directory = resolve(root),prefix = uploadOwnerPrefix(owner);
  async function privateDirectory(path: string,optional: boolean) {
    let details;
    try { details = await lstat(path); }
    catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
      throw new Error("Upload inventory encountered a non-private directory or symlink.");
    return true;
  }
  await privateDirectory(directory,false);
  let current = directory;
  for (const part of prefix.slice(0,-1).split("/")) {
    current = join(current,part);
    if (!await privateDirectory(current,true)) return 0;
  }
  const items = await readdir(current);
  for (const item of items) {
    const details = await lstat(join(current,item));
    if (!details.isFile() || details.isSymbolicLink()) throw new Error("Upload inventory encountered a non-file object.");
  }
  return items.length;
}

/** Counts all keys under the owner's S3 prefix, including catalog orphans. */
export async function inspectS3OwnerObjects(client: S3Client,bucket: string,owner: AccessOwner) {
  const prefix = uploadOwnerPrefix(owner);
  await verifyPrivateS3Bucket(client,bucket);
  let continuation: string | undefined,count = 0;
  for (let page = 0;page < MAX_PAGES;page++) {
    const response = await client.send(new ListObjectsV2Command({ Bucket: bucket,Prefix: prefix,MaxKeys: 1000,
      ...(continuation ? { ContinuationToken: continuation } : {}) }),{ abortSignal: AbortSignal.timeout(30_000) });
    for (const object of response.Contents ?? []) {
      if (!object.Key?.startsWith(prefix) || object.Key.length <= prefix.length) throw new Error("Unexpected S3 inventory key.");
      count++;
      if (!Number.isSafeInteger(count)) throw new Error("Upload object inventory count exceeded the supported range.");
    }
    if (typeof response.IsTruncated !== "boolean") throw new Error("S3 upload inventory returned an incomplete listing.");
    if (!response.IsTruncated) return count;
    if (!response.NextContinuationToken || response.NextContinuationToken === continuation)
      throw new Error("S3 upload inventory pagination did not advance.");
    continuation = response.NextContinuationToken;
  }
  throw new Error("S3 upload inventory exceeded the page limit.");
}

type Storage = ReturnType<typeof uploadStorageClient>["storage"];

/** Counts one owner prefix through the private Supabase Storage service. */
export async function inspectSupabaseOwnerObjects(storage: Storage,owner: AccessOwner) {
  await verifyPrivateUploadBucket(storage);
  const prefix = uploadOwnerPrefix(owner).slice(0,-1);
  let count = 0;
  for (let page = 0;page < MAX_PAGES;page++) {
    const { data,error } = await storage.from(SUPABASE_UPLOAD_BUCKET).list(prefix,{ limit: 100,offset: page*100,
      sortBy: { column: "name",order: "asc" } });
    if (error) throw error;
    if (!data) throw new Error("Supabase upload inventory returned no listing.");
    for (const object of data) {
      if (!object.name || typeof object.id !== "string" || !object.id)
        throw new Error("Supabase upload inventory encountered an unexpected folder.");
      count++;
      if (!Number.isSafeInteger(count)) throw new Error("Upload object inventory count exceeded the supported range.");
    }
    if (data.length < 100) return count;
  }
  throw new Error("Supabase upload inventory exceeded the page limit.");
}
