import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import {
  DeleteObjectCommand,GetBucketVersioningCommand,GetObjectCommand,GetPublicAccessBlockCommand,
  HeadObjectCommand,ListObjectsV2Command,PutObjectCommand,S3Client,
} from "@aws-sdk/client-s3";
import { expect,it } from "vitest";
import { awsS3Settings,awsS3UploadObjects } from "../../lib/uploads/aws-s3";
import { uploadObjectKey } from "../../lib/uploads/contract";
import { uploadStorageEnabled } from "../../lib/uploads/provider";
import { MAX_UPLOAD_BYTES } from "../../lib/uploads/validation";
import { uploadObjectContract } from "../contracts/uploads";
import { exerciseAwsS3Bucket,S3LiveCheckError } from "../../scripts/test-upload-s3-live";

const bucket = "jumpstart-private-uploads";
const owner = { tenant: "tenant/private",subject: "alice@example.test" };
const missing = (name: string) => Object.assign(new Error("missing"),{ name });

function fakeS3() {
  const objects = new Map<string,Uint8Array>();
  const calls: unknown[] = [];
  let publicBlock = true,versioning: "Enabled" | "Suspended" | undefined,deleteFailure = false;
  let readOverride: (() => { Body: Readable;ContentLength?: number }) | undefined;
  const client = { async send(command: unknown) {
    calls.push(command);
    if (command instanceof GetPublicAccessBlockCommand) return { PublicAccessBlockConfiguration: {
      BlockPublicAcls: publicBlock,IgnorePublicAcls: publicBlock,
      BlockPublicPolicy: publicBlock,RestrictPublicBuckets: publicBlock,
    } };
    if (command instanceof GetBucketVersioningCommand) return { Status: versioning };
    if (command instanceof ListObjectsV2Command) return { Contents: [...objects.keys()]
      .filter(key => key.startsWith(command.input.Prefix ?? "")).map(Key => ({ Key })),IsTruncated: false };
    if (command instanceof PutObjectCommand) {
      if (command.input.IfNoneMatch !== "*") throw new Error("unconditional write");
      const key = command.input.Key!;
      if (objects.has(key)) throw Object.assign(new Error("precondition"),{ name: "PreconditionFailed" });
      objects.set(key,Uint8Array.from(command.input.Body as Uint8Array));
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const bytes = objects.get(command.input.Key!);
      if (!bytes) throw missing("NoSuchKey");
      return readOverride?.() ?? { Body: Readable.from([bytes]),ContentLength: bytes.length };
    }
    if (command instanceof HeadObjectCommand) {
      const bytes = objects.get(command.input.Key!);
      if (!bytes) throw missing("NotFound");
      return { ContentType: "application/octet-stream",CacheControl: "no-store",ContentLength: bytes.length };
    }
    if (command instanceof DeleteObjectCommand) {
      if (deleteFailure) throw new Error("delete unavailable");
      objects.delete(command.input.Key!);return {};
    }
    throw new Error("unexpected S3 command");
  } } as unknown as S3Client;
  return { client,objects,calls,setPublic: () => { publicBlock = false; },
    setVersioning: (value: "Enabled" | "Suspended") => { versioning = value; },
    setDeleteFailure: (value: boolean) => { deleteFailure = value; },
    setRead: (value: () => { Body: Readable;ContentLength?: number }) => { readOverride = value; } };
}

uploadObjectContract("AWS S3 adapter",async () => ({ store: awsS3UploadObjects(fakeS3().client,bucket),close: async () => {} }));

it("uses an opaque owner key, single conditional write and no public URL",async () => {
  const fake = fakeS3(),id = randomUUID(),bytes = new TextEncoder().encode("private");
  await awsS3UploadObjects(fake.client,bucket).put(owner,id,bytes);
  const put = fake.calls.find(call => call instanceof PutObjectCommand) as PutObjectCommand;
  expect(put.input).toMatchObject({ Bucket: bucket,Key: uploadObjectKey(owner,id),
    ContentType: "application/octet-stream",ContentLength: bytes.length,IfNoneMatch: "*" });
  expect([...fake.objects.keys()]).toEqual([uploadObjectKey(owner,id)]);
});

it("refuses a public or previously versioned bucket before object commands",async () => {
  const fake = fakeS3(),store = awsS3UploadObjects(fake.client,bucket),id = randomUUID();
  fake.setPublic();
  await expect(store.put(owner,id,Uint8Array.of(1))).rejects.toThrow("block all public access");
  expect(fake.calls.some(call => call instanceof PutObjectCommand)).toBe(false);
  const versioned = fakeS3(),other = awsS3UploadObjects(versioned.client,bucket);
  versioned.setVersioning("Suspended");
  await expect(other.get(owner,id)).rejects.toThrow("never enabled versioning");
  expect(versioned.calls.some(call => call instanceof GetObjectCommand)).toBe(false);
});

it("bounds stored bytes even when object metadata omits its length",async () => {
  const fake = fakeS3(),store = awsS3UploadObjects(fake.client,bucket),id = randomUUID();
  await store.put(owner,id,Uint8Array.of(1));
  fake.setRead(() => ({ Body: Readable.from([Buffer.alloc(MAX_UPLOAD_BYTES),Buffer.of(1)]) }));
  await expect(store.get(owner,id)).rejects.toThrow("exceeds the maximum size");
  await expect(store.put(owner,randomUUID(),new Uint8Array(MAX_UPLOAD_BYTES+1))).rejects.toThrow("Upload size is invalid");
});

it("accepts only explicit AWS region and bucket configuration",() => {
  expect(uploadStorageEnabled("aws-s3")).toBe(true);
  expect(uploadStorageEnabled("unknown")).toBe(false);
  expect(awsS3Settings({ UPLOAD_S3_REGION: "eu-west-1",UPLOAD_S3_BUCKET: bucket })).toEqual({ region: "eu-west-1",bucket });
  expect(() => awsS3Settings({ UPLOAD_S3_REGION: "eu-west-1",UPLOAD_S3_BUCKET: "https://example.com/private" })).toThrow();
  expect(() => awsS3Settings({ UPLOAD_S3_REGION: "eu-west-1",UPLOAD_S3_BUCKET: "private..bucket" })).toThrow();
});

it("uses signed SDK requests and conditional writes through a real S3 wire protocol",async () => {
  const objects = new Map<string,Buffer>(),methods: string[] = [];
  const server = createServer(async (request,response) => {
    const url = new URL(request.url ?? "/","http://127.0.0.1"),key = url.pathname.slice(`/${bucket}/`.length);
    methods.push(`${request.method} ${url.pathname}${url.search}`);
    if (!request.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ")) { response.writeHead(403).end();return; }
    if (url.searchParams.has("publicAccessBlock")) {
      response.writeHead(200,{ "content-type": "application/xml" }).end(`<PublicAccessBlockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><BlockPublicAcls>true</BlockPublicAcls><IgnorePublicAcls>true</IgnorePublicAcls><BlockPublicPolicy>true</BlockPublicPolicy><RestrictPublicBuckets>true</RestrictPublicBuckets></PublicAccessBlockConfiguration>`);
    } else if (url.searchParams.has("versioning")) {
      response.writeHead(200,{ "content-type": "application/xml" }).end(`<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"/>`);
    } else if (request.method === "PUT") {
      if (request.headers["if-none-match"] !== "*") { response.writeHead(400).end();return; }
      if (objects.has(key)) { response.writeHead(412,{ "content-type": "application/xml" }).end("<Error><Code>PreconditionFailed</Code></Error>");return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      objects.set(key,Buffer.concat(chunks));response.writeHead(200).end();
    } else if (request.method === "GET" || request.method === "HEAD") {
      const bytes = objects.get(key);
      if (!bytes) { response.writeHead(404,{ "content-type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");return; }
      response.writeHead(200,{ "content-length": String(bytes.length) }).end(request.method === "GET" ? bytes : undefined);
    } else if (request.method === "DELETE") {
      objects.delete(key);response.writeHead(204).end();
    } else response.writeHead(400).end();
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("S3 fixture address is unavailable.");
  const client = new S3Client({ region: "us-east-1",endpoint: `http://127.0.0.1:${address.port}`,
    forcePathStyle: true,credentials: { accessKeyId: "fixture-access",secretAccessKey: "fixture-secret" },maxAttempts: 1 });
  try {
    const store = awsS3UploadObjects(client,bucket),id = randomUUID(),bytes = new TextEncoder().encode("private");
    await store.put(owner,id,bytes);
    expect(await store.get(owner,id)).toEqual(bytes);
    await expect(store.put(owner,id,Uint8Array.of(9))).rejects.toBeDefined();
    expect(await store.delete(owner,id)).toBe(true);
    expect(await store.get(owner,id)).toBeNull();
    expect(await store.delete(owner,id)).toBe(false);
    expect(methods.some(method => method.startsWith("PUT /"))).toBe(true);
  } finally { client.destroy();await new Promise<void>(resolve => server.close(() => resolve())); }
});

it("rehearses the operator acceptance sequence and removes its random objects",async () => {
  const fake = fakeS3();
  await expect(exerciseAwsS3Bucket(fake.client,bucket)).resolves.toMatchObject({ objectsRemoved: 2 });
  expect(fake.objects.size).toBe(0);
});

it("removes random objects after an acceptance mismatch",async () => {
  const fake = fakeS3();
  fake.setRead(() => ({ Body: Readable.from([Buffer.from("tampered")]) }));
  await expect(exerciseAwsS3Bucket(fake.client,bucket)).rejects.toMatchObject({ stage: "owner isolation and conditional write",cleanupKeys: [] } satisfies Partial<S3LiveCheckError>);
  expect(fake.objects.size).toBe(0);
});

it("reports opaque keys when live cleanup cannot remove test objects",async () => {
  const fake = fakeS3();
  fake.setDeleteFailure(true);
  const failure = await exerciseAwsS3Bucket(fake.client,bucket).catch(error => error);
  expect(failure).toBeInstanceOf(S3LiveCheckError);
  expect(failure.stage).toBe("owner deletion and missing-object reads");
  expect(failure.cleanupKeys).toHaveLength(2);
  expect(failure.cleanupKeys.every((key: string) => key.startsWith("uploads/v1/") && !key.includes("jumpstart-live"))).toBe(true);
});
