import { mkdtempSync,rmSync,symlinkSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetBucketVersioningCommand,GetPublicAccessBlockCommand,ListObjectsV2Command,type S3Client } from "@aws-sdk/client-s3";
import { expect,it } from "vitest";
import { uploadOwnerPrefix } from "../../lib/uploads/contract";
import { localUploadObjects } from "../../lib/uploads/local";
import { inspectLocalOwnerObjects,inspectS3OwnerObjects,inspectSupabaseOwnerObjects } from "../../lib/uploads/object-inventory";
import { SUPABASE_UPLOAD_BUCKET } from "../../lib/uploads/supabase";
import { MAX_UPLOAD_BYTES } from "../../lib/uploads/validation";
import { inspectAccountObjects } from "../../scripts/inspect-account-objects";

const owner = { tenant: "private-tenant",subject: "alice-private" },foreign = { ...owner,subject: "bob-private" };

it("counts local owner objects left without catalog rows and rejects symlinked entries",async () => {
  const root = mkdtempSync(join(tmpdir(),"jumpstart-object-inventory-")),store = localUploadObjects(root);
  try {
    await store.put(owner,crypto.randomUUID(),new Uint8Array([1]));
    writeFileSync(join(root,uploadOwnerPrefix(owner),crypto.randomUUID()),"orphan bytes");
    expect(await inspectLocalOwnerObjects(root,owner)).toBe(2);
    expect(await inspectLocalOwnerObjects(root,foreign)).toBe(0);
    const report = await inspectAccountObjects("local",owner,{ UPLOAD_LOCAL_ROOT: root });
    expect(report).toMatchObject({ provider: "local",objectCount: 2 });
    expect(JSON.stringify(report)).not.toContain(owner.tenant);
    expect(JSON.stringify(report)).not.toContain(owner.subject);
    symlinkSync(join(root,uploadOwnerPrefix(owner),"missing-target"),join(root,uploadOwnerPrefix(owner),"unsafe-link"));
    await expect(inspectLocalOwnerObjects(root,owner)).rejects.toThrow("non-file");
  } finally { rmSync(root,{ recursive: true,force: true }); }
});

it("counts every S3 page under only the opaque owner prefix and refuses stalled pagination",async () => {
  const prefix = uploadOwnerPrefix(owner),seen: unknown[] = [];
  const client = { async send(command: unknown) {
    seen.push(command);
    if (command instanceof GetPublicAccessBlockCommand) return { PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,IgnorePublicAcls: true,BlockPublicPolicy: true,RestrictPublicBuckets: true } };
    if (command instanceof GetBucketVersioningCommand) return {};
    if (command instanceof ListObjectsV2Command) {
      expect(command.input.Prefix).toBe(prefix);
      return command.input.ContinuationToken
        ? { Contents: [{ Key: `${prefix}orphan` }],IsTruncated: false }
        : { Contents: [{ Key: `${prefix}cataloged` }],IsTruncated: true,NextContinuationToken: "next" };
    }
    throw new Error("unexpected S3 command");
  } } as unknown as S3Client;
  expect(await inspectS3OwnerObjects(client,"private-bucket",owner)).toBe(2);
  expect(seen.filter(command => command instanceof ListObjectsV2Command)).toHaveLength(2);
  const stalled = { async send(command: unknown) {
    if (command instanceof GetPublicAccessBlockCommand) return { PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,IgnorePublicAcls: true,BlockPublicPolicy: true,RestrictPublicBuckets: true } };
    if (command instanceof GetBucketVersioningCommand) return {};
    return { IsTruncated: true };
  } } as unknown as S3Client;
  await expect(inspectS3OwnerObjects(stalled,"private-bucket",owner)).rejects.toThrow("did not advance");
});

it("pages private Supabase Storage and refuses folder results instead of reporting false zero",async () => {
  const prefix = uploadOwnerPrefix(owner).slice(0,-1),offsets: number[] = [];
  const storage = { async getBucket(bucket: string) {
    expect(bucket).toBe(SUPABASE_UPLOAD_BUCKET);
    return { data: { id: bucket,public: false,file_size_limit: MAX_UPLOAD_BYTES,allowed_mime_types: ["application/octet-stream"] },error: null };
  },from(bucket: string) {
    expect(bucket).toBe(SUPABASE_UPLOAD_BUCKET);
    return { async list(path: string,options: { offset: number;limit: number }) {
      expect(path).toBe(prefix);expect(options.limit).toBe(100);offsets.push(options.offset);
      return { data: options.offset === 0
        ? Array.from({ length: 100 },(_,index) => ({ id: `id-${index}`,name: `object-${index}` }))
        : [{ id: "orphan",name: "orphan" }],error: null };
    } };
  } } as unknown as Parameters<typeof inspectSupabaseOwnerObjects>[0];
  expect(await inspectSupabaseOwnerObjects(storage,owner)).toBe(101);
  expect(offsets).toEqual([0,100]);
  const folder = { ...storage,from: () => ({ list: async () => ({ data: [{ id: null,name: "nested" }],error: null }) }) } as unknown as Parameters<typeof inspectSupabaseOwnerObjects>[0];
  await expect(inspectSupabaseOwnerObjects(folder,owner)).rejects.toThrow("unexpected folder");
});
