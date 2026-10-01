import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HeadObjectCommand,type S3Client } from "@aws-sdk/client-s3";
import { awsS3Client,awsS3Settings,awsS3UploadObjects,verifyPrivateS3Bucket } from "../lib/uploads/aws-s3";
import { uploadObjectKey } from "../lib/uploads/contract";
import { inspectS3OwnerObjects } from "../lib/uploads/object-inventory";
import { listS3OwnerObjectIds } from "../lib/uploads/object-export";
import { exportAccountObjects } from "./export-account-objects";
import { verifyExport } from "./verify-export";

type Owner = { tenant: string;subject: string };
type Created = { owner: Owner;id: string };

export class S3LiveCheckError extends Error {
  constructor(readonly stage: string,readonly cleanupKeys: string[]) { super("AWS S3 live acceptance failed."); }
}

function conditionalWriteRejected(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error &&
    (error.name === "PreconditionFailed" || error.name === "ConditionalRequestConflict");
}

/** Writes only random test keys and always attempts to remove them. */
export async function exerciseAwsS3Bucket(client: S3Client,bucket: string) {
  const store = awsS3UploadObjects(client,bucket),run = randomUUID();
  const first: Owner = { tenant: `jumpstart-live-${run}`,subject: "first" };
  const second: Owner = { tenant: `jumpstart-live-${run}`,subject: "second" };
  const created: Created[] = [];
  let stage = "bucket preflight",failure: unknown;
  try {
    await verifyPrivateS3Bucket(client,bucket);
    stage = "owner isolation and conditional write";
    const id = randomUUID(),initial = Buffer.from("jumpstart private S3 acceptance v1");
    created.push({ owner: first,id });
    await store.put(first,id,initial);
    assert.equal(await inspectS3OwnerObjects(client,bucket,first),1);
    assert.equal(await inspectS3OwnerObjects(client,bucket,second),0);
    assert.deepEqual(await store.get(first,id),Uint8Array.from(initial));
    assert.equal(await store.get(second,id),null);
    assert.equal(await store.delete(second,id),false);
    await assert.rejects(() => store.put(first,id,Buffer.from("replacement")),conditionalWriteRejected);
    assert.deepEqual(await store.get(first,id),Uint8Array.from(initial));
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket,Key: uploadObjectKey(first,id) }),
      { abortSignal: AbortSignal.timeout(30_000) });
    assert.equal(head.ContentType,"application/octet-stream");
    assert.equal(head.CacheControl,"no-store");
    assert.equal(head.ContentLength,initial.length);

    stage = "concurrent conditional writers";
    const raceId = randomUUID(),attempts = [Buffer.from("first writer"),Buffer.from("second writer")];
    created.push({ owner: first,id: raceId });
    const settled = await Promise.allSettled(attempts.map(bytes => store.put(first,raceId,bytes)));
    const winners = settled.flatMap((result,index) => result.status === "fulfilled" ? [index] : []);
    assert.equal(winners.length,1,"Exactly one conditional S3 write must succeed.");
    assert.equal(settled.every(result => result.status === "fulfilled" || conditionalWriteRejected(result.reason)),true,
      "The losing writer must fail because its S3 condition was rejected.");
    assert.deepEqual(await store.get(first,raceId),Uint8Array.from(attempts[winners[0]]));
    assert.equal(await inspectS3OwnerObjects(client,bucket,first),2);

    stage = "private object export";
    const directory = await mkdtemp(join(tmpdir(),"jumpstart-s3-export-"));
    try {
      const output = join(directory,"private.ndjson");
      assert.deepEqual(await exportAccountObjects({ list: () => listS3OwnerObjectIds(client,bucket,first),
        get: objectId => store.get(first,objectId) },output,"aws-s3"),{ objects: 2 });
      assert.deepEqual((await verifyExport(output)).counts,{ objects: 2 });
    } finally { await rm(directory,{ recursive: true,force: true }); }

    stage = "owner deletion and missing-object reads";
    assert.equal(await store.delete(first,id),true);
    assert.equal(await store.get(first,id),null);
    assert.equal(await store.delete(first,id),false);
    assert.equal(await store.delete(first,raceId),true);
    assert.equal(await store.get(first,raceId),null);
    assert.equal(await inspectS3OwnerObjects(client,bucket,first),0);
  } catch (error) { failure = error; }
  const cleanupKeys: string[] = [];
  for (const item of created.reverse()) {
    try {
      await store.delete(item.owner,item.id);
      if (await store.get(item.owner,item.id) !== null) throw new Error("Object remains after cleanup.");
    } catch { cleanupKeys.push(uploadObjectKey(item.owner,item.id)); }
  }
  if (failure || cleanupKeys.length) throw new S3LiveCheckError(stage,cleanupKeys);
  return { checked: "private bucket, owner isolation, metadata, conditional race, deletion",objectsRemoved: created.length };
}

async function main(args: string[]) {
  if (args.length !== 1 || args[0] !== "--write-disposable") {
    console.error("Usage: npm run test:upload-s3:live -- --write-disposable (requires a disposable UPLOAD_S3_BUCKET and UPLOAD_S3_REGION)");
    process.exitCode = 2;return;
  }
  let client: S3Client | undefined;
  try {
    const { region,bucket } = awsS3Settings(process.env);
    client = awsS3Client(region);
    const result = await exerciseAwsS3Bucket(client,bucket);
    console.log(`AWS S3 live upload acceptance passed; ${result.objectsRemoved} random test objects removed.`);
  } catch (error) {
    // Never print SDK exceptions: they can include endpoints or credential details.
    console.error(`AWS S3 live upload acceptance failed at ${error instanceof S3LiveCheckError ? error.stage : "configuration or connection"}.`);
    if (error instanceof S3LiveCheckError && error.cleanupKeys.length) {
      console.error("Manually remove these random test object keys before retrying:");
      for (const key of error.cleanupKeys) console.error(key);
    }
    process.exitCode = 1;
  } finally { client?.destroy(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2));
