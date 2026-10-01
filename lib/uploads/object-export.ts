import { constants } from "node:fs";
import { lstat,open,readdir } from "node:fs/promises";
import { isAbsolute,join,resolve } from "node:path";
import { ListObjectsV2Command,type S3Client } from "@aws-sdk/client-s3";
import type { AccessOwner } from "../agent-access/contract";
import { uploadObjectKey,uploadOwnerPrefix } from "./contract";
import { uploadId } from "./schema";
import { verifyPrivateS3Bucket } from "./aws-s3";
import { SUPABASE_UPLOAD_BUCKET,verifyPrivateUploadBucket,type uploadStorageClient } from "./supabase";
import { MAX_UPLOAD_BYTES } from "./validation";

const MAX_OBJECTS = 100_000;
const MAX_PAGES = 10_000;
type Storage = ReturnType<typeof uploadStorageClient>["storage"];

function checkedId(value: string) {
  const id = uploadId.parse(value);
  if (id !== value) throw new Error("Private upload key is not canonical.");
  return id;
}

function sortedIds(ids: string[]) {
  if (ids.length > MAX_OBJECTS) throw new Error("Private object export exceeded its object limit.");
  ids.sort();
  for (let index = 1;index < ids.length;index++) {
    if (ids[index] === ids[index-1]) throw new Error("Private object listing repeated a key.");
  }
  return ids;
}

async function privateDirectory(path: string,optional = false) {
  let details;
  try { details = await lstat(path); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
    throw new Error("Private object export requires a private real directory.");
  return true;
}

async function localOwnerDirectory(root: string,owner: AccessOwner) {
  if (!isAbsolute(root)) throw new Error("Private upload root must be absolute.");
  const directory = resolve(root);
  await privateDirectory(directory);
  let current = directory;
  for (const part of uploadOwnerPrefix(owner).slice(0,-1).split("/")) {
    current = join(current,part);
    if (!await privateDirectory(current,true)) return null;
  }
  return current;
}

export async function listLocalOwnerObjectIds(root: string,owner: AccessOwner) {
  const directory = await localOwnerDirectory(root,owner);
  if (!directory) return [];
  const ids: string[] = [];
  for (const name of await readdir(directory)) {
    checkedId(name);
    const details = await lstat(join(directory,name));
    if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
      throw new Error("Private object export encountered an unsafe entry.");
    ids.push(name);
  }
  return sortedIds(ids);
}

/** Read a local object without following a final-component symlink, then detect concurrent modification. */
export async function readLocalOwnerObject(root: string,owner: AccessOwner,id: string) {
  const directory = await localOwnerDirectory(root,owner);
  if (!directory) throw new Error("Private object disappeared during export.");
  const file = await open(join(directory,checkedId(id)),constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || (before.mode & 0o077) !== 0 || before.size < 1 || before.size > MAX_UPLOAD_BYTES)
      throw new Error("Private object has unsafe permissions or size.");
    const bytes = await file.readFile();
    const after = await file.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw new Error("Private object changed during export.");
    return bytes;
  } finally { await file.close(); }
}

export async function listS3OwnerObjectIds(client: S3Client,bucket: string,owner: AccessOwner) {
  const prefix = uploadOwnerPrefix(owner),ids: string[] = [];
  await verifyPrivateS3Bucket(client,bucket);
  let continuation: string | undefined;
  for (let page = 0;page < MAX_PAGES;page++) {
    const response = await client.send(new ListObjectsV2Command({ Bucket: bucket,Prefix: prefix,MaxKeys: 1000,
      ...(continuation ? { ContinuationToken: continuation } : {}) }),{ abortSignal: AbortSignal.timeout(30_000) });
    for (const object of response.Contents ?? []) {
      const key = object.Key;
      if (!key?.startsWith(prefix)) throw new Error("Private S3 listing returned an unrelated key.");
      const id = checkedId(key.slice(prefix.length));
      if (uploadObjectKey(owner,id) !== key) throw new Error("Private S3 listing returned an unexpected key.");
      ids.push(id);
      if (ids.length > MAX_OBJECTS) throw new Error("Private object export exceeded its object limit.");
    }
    if (typeof response.IsTruncated !== "boolean") throw new Error("Private S3 listing is incomplete.");
    if (!response.IsTruncated) return sortedIds(ids);
    if (!response.NextContinuationToken || response.NextContinuationToken === continuation)
      throw new Error("Private S3 listing did not advance.");
    continuation = response.NextContinuationToken;
  }
  throw new Error("Private S3 listing exceeded its page limit.");
}

export async function listSupabaseOwnerObjectIds(storage: Storage,owner: AccessOwner) {
  await verifyPrivateUploadBucket(storage);
  const prefix = uploadOwnerPrefix(owner).slice(0,-1),ids: string[] = [];
  for (let page = 0;page < MAX_PAGES;page++) {
    const { data,error } = await storage.from(SUPABASE_UPLOAD_BUCKET).list(prefix,{ limit: 100,offset: page*100,
      sortBy: { column: "name",order: "asc" } });
    if (error) throw error;
    if (!data) throw new Error("Private Supabase listing is unavailable.");
    for (const object of data) {
      if (!object.name || typeof object.id !== "string" || !object.id)
        throw new Error("Private Supabase listing encountered a folder.");
      ids.push(checkedId(object.name));
      if (ids.length > MAX_OBJECTS) throw new Error("Private object export exceeded its object limit.");
    }
    if (data.length < 100) return sortedIds(ids);
  }
  throw new Error("Private Supabase listing exceeded its page limit.");
}
