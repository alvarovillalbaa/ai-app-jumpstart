import {
  DeleteObjectCommand,GetBucketVersioningCommand,GetObjectCommand,GetPublicAccessBlockCommand,
  HeadObjectCommand,PutObjectCommand,S3Client,
} from "@aws-sdk/client-s3";
import { uploadObjectKey,type PrivateUploadObjects } from "./contract";
import { MAX_UPLOAD_BYTES } from "./validation";

const CONTENT_TYPE = "application/octet-stream";
const clients = new Map<string,S3Client>();

/** AWS S3 uses the SDK credential chain: workload roles first, operator credentials only when configured. */
export function awsS3Settings(env: Record<string,string | undefined>) {
  const region = env.UPLOAD_S3_REGION,bucket = env.UPLOAD_S3_BUCKET;
  if (!region || !/^[a-z0-9-]{5,32}$/u.test(region) ||
      !bucket || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(bucket) ||
      bucket.includes("..") || bucket.includes(".-") || bucket.includes("-.")) {
    throw new Error("Set a valid UPLOAD_S3_REGION and private UPLOAD_S3_BUCKET.");
  }
  return { region,bucket };
}

export function awsS3Client(region: string) {
  let client = clients.get(region);
  if (!client) { client = new S3Client({ region,maxAttempts: 2,ignoreConfiguredEndpointUrls: true });clients.set(region,client); }
  return client;
}

function missingObject(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error &&
    (error.name === "NoSuchKey" || error.name === "NotFound");
}

/** Refuse public buckets and versioned buckets, where plain DELETE would retain old bytes. */
export async function verifyPrivateS3Bucket(client: S3Client,bucket: string) {
  const access = await client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(30_000) });
  const block = access.PublicAccessBlockConfiguration;
  if (block?.BlockPublicAcls !== true || block.IgnorePublicAcls !== true ||
      block.BlockPublicPolicy !== true || block.RestrictPublicBuckets !== true)
    throw new Error("Upload S3 bucket must block all public access.");
  const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(30_000) });
  if (versioning.Status) throw new Error("Upload S3 bucket must have never enabled versioning; plain deletion retains versions.");
}

/** Objects remain quarantined; the shared catalog, scanner and review services own release. */
export function awsS3UploadObjects(client: S3Client,bucket: string): PrivateUploadObjects {
  return {
    async put(owner,id,bytes) {
      if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error("Upload size is invalid.");
      const key = uploadObjectKey(owner,id);
      await verifyPrivateS3Bucket(client,bucket);
      await client.send(new PutObjectCommand({ Bucket: bucket,Key: key,Body: Buffer.from(bytes),
        ContentLength: bytes.length,ContentType: CONTENT_TYPE,CacheControl: "no-store",IfNoneMatch: "*" }),
      { abortSignal: AbortSignal.timeout(30_000) });
    },
    async get(owner,id) {
      const key = uploadObjectKey(owner,id);
      await verifyPrivateS3Bucket(client,bucket);
      const abort = new AbortController(),timeout = setTimeout(() => abort.abort(),30_000);
      try {
        let result;
        try { result = await client.send(new GetObjectCommand({ Bucket: bucket,Key: key }), { abortSignal: abort.signal }); }
        catch (error) { if (missingObject(error)) return null;throw error; }
        if (result.ContentLength !== undefined && result.ContentLength > MAX_UPLOAD_BYTES) {
          abort.abort();throw new Error("Stored upload exceeds the maximum size.");
        }
        const body = result.Body as unknown;
        if (!body || typeof body !== "object" || !(Symbol.asyncIterator in body)) throw new Error("Stored upload body is unavailable.");
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const part of body as AsyncIterable<Uint8Array>) {
          size += part.byteLength;
          if (size > MAX_UPLOAD_BYTES) { abort.abort();throw new Error("Stored upload exceeds the maximum size."); }
          chunks.push(Uint8Array.from(part));
        }
        if (result.ContentLength !== undefined && size !== result.ContentLength) throw new Error("Stored upload length changed during read.");
        return Uint8Array.from(Buffer.concat(chunks,size));
      } finally { clearTimeout(timeout); }
    },
    async delete(owner,id) {
      const key = uploadObjectKey(owner,id);
      await verifyPrivateS3Bucket(client,bucket);
      try { await client.send(new HeadObjectCommand({ Bucket: bucket,Key: key }), { abortSignal: AbortSignal.timeout(30_000) }); }
      catch (error) { if (missingObject(error)) return false;throw error; }
      await client.send(new DeleteObjectCommand({ Bucket: bucket,Key: key }), { abortSignal: AbortSignal.timeout(30_000) });
      return true;
    },
  };
}
