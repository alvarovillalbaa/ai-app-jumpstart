import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,symlinkSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GetBucketVersioningCommand,GetPublicAccessBlockCommand,ListObjectsV2Command,type S3Client } from "@aws-sdk/client-s3";
import { expect,it } from "vitest";
import { uploadOwnerPrefix } from "../../lib/uploads/contract";
import { localUploadObjects } from "../../lib/uploads/local";
import { listS3OwnerObjectIds,listSupabaseOwnerObjectIds } from "../../lib/uploads/object-export";
import { SUPABASE_UPLOAD_BUCKET } from "../../lib/uploads/supabase";
import { MAX_UPLOAD_BYTES } from "../../lib/uploads/validation";
import { exportAccountObjects,exportSelectedAccountObjects } from "../../scripts/export-account-objects";
import { verifyExport } from "../../scripts/verify-export";

const owner = { tenant: "private-tenant",subject: "private-alice" };

it("exports actual private local bytes including a catalog orphan, and verifies each payload",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-object-export-")),root = join(dir,"uploads"),output = join(dir,"account.ndjson");
  try {
    const objects = localUploadObjects(root),id = crypto.randomUUID(),foreign = { ...owner,subject: "private-bob" };
    const bytes = new Uint8Array([0,1,2,255]);
    await objects.put(owner,id,bytes);
    await objects.put(foreign,crypto.randomUUID(),new Uint8Array([9]));
    expect(await exportSelectedAccountObjects("local",owner,output,{ UPLOAD_LOCAL_ROOT: root })).toEqual({ objects: 1 });
    expect(statSync(output).mode & 0o077).toBe(0);
    expect(await verifyExport(output)).toMatchObject({ mode: "private-objects",counts: { objects: 1 } });
    const lines = readFileSync(output,"utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    expect(lines[1]).toMatchObject({ type: "object",value: { id,size: bytes.length,base64: Buffer.from(bytes).toString("base64") } });
    expect(readFileSync(output,"utf8")).not.toContain(owner.tenant);
    expect(readFileSync(output,"utf8")).not.toContain(owner.subject);
    await expect(exportSelectedAccountObjects("local",owner,output,{ UPLOAD_LOCAL_ROOT: root })).rejects.toThrow();
    expect(await verifyExport(output)).toMatchObject({ counts: { objects: 1 } });
    const cliOutput = join(dir,"cli.ndjson"),command = ["node_modules/tsx/dist/cli.mjs","scripts/export-account-objects.ts",
      "--output",cliOutput,"--stopped"];
    const env = { ...process.env,ACCOUNT_AUDIT_TENANT: owner.tenant,ACCOUNT_AUDIT_SUBJECT: owner.subject,
      UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: root };
    const denied = spawnSync(process.execPath,command.slice(0,-1),{ cwd: process.cwd(),encoding: "utf8",env });
    expect(denied.status).toBe(2);
    expect(readdirSync(dir)).not.toContain("cli.ndjson");
    const cli = spawnSync(process.execPath,command,{ cwd: process.cwd(),encoding: "utf8",env });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual({ objects: 1 });
    expect(cli.stdout).not.toContain(owner.tenant);
    expect(await verifyExport(cliOutput)).toMatchObject({ counts: { objects: 1 } });
    const verified = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/app-cli.ts",
      "export","verify",cliOutput],{ cwd: process.cwd(),encoding: "utf8",env });
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toMatchObject({ mode: "private-objects",counts: { objects: 1 } });

    // Recompute the outer digest after changing bytes: the per-object digest must still catch it.
    lines[1].value.base64 = Buffer.from("changed").toString("base64");
    lines[1].value.size = 7;
    const content = `${JSON.stringify(lines[0])}\n${JSON.stringify(lines[1])}\n`;
    lines[2].value.contentSha256 = createHash("sha256").update(content).digest("hex");
    const tampered = join(dir,"tampered.ndjson");
    writeFileSync(tampered,`${content}${JSON.stringify(lines[2])}\n`,{ mode: 0o600 });
    await expect(verifyExport(tampered)).rejects.toThrow("Private object content checksum");
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});

it("does not publish partial files when bytes disappear, listings change or local entries are unsafe",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-object-export-fail-")),root = join(dir,"uploads"),output = join(dir,"account.ndjson"),id = crypto.randomUUID();
  try {
    await expect(exportAccountObjects({ list: async () => [id],get: async () => null },output,"local")).rejects.toThrow("disappeared");
    expect(readdirSync(dir).filter(name => name.startsWith(".jumpstart-object-export-"))).toEqual([]);
    let calls = 0;
    await expect(exportAccountObjects({ list: async () => ++calls === 1 ? [id] : [],get: async () => new Uint8Array([1]) },output,"local"))
      .rejects.toThrow("listing changed");
    expect(readdirSync(dir)).not.toContain("account.ndjson");

    const objects = localUploadObjects(root);
    await objects.put(owner,id,new Uint8Array([1]));
    symlinkSync(join(root,uploadOwnerPrefix(owner),id),join(root,uploadOwnerPrefix(owner),crypto.randomUUID()));
    await expect(exportSelectedAccountObjects("local",owner,output,{ UPLOAD_LOCAL_ROOT: root })).rejects.toThrow("unsafe entry");
    expect(readdirSync(dir)).not.toContain("account.ndjson");
    chmodSync(root,0o755);
    await expect(exportSelectedAccountObjects("local",owner,output,{ UPLOAD_LOCAL_ROOT: root })).rejects.toThrow("private real directory");
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});

it("lists canonical owner UUIDs through guarded S3 and Supabase pagination",async () => {
  const first = crypto.randomUUID(),second = crypto.randomUUID(),prefix = uploadOwnerPrefix(owner);
  const s3 = { async send(command: unknown) {
    if (command instanceof GetPublicAccessBlockCommand) return { PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,IgnorePublicAcls: true,BlockPublicPolicy: true,RestrictPublicBuckets: true } };
    if (command instanceof GetBucketVersioningCommand) return {};
    if (command instanceof ListObjectsV2Command) return command.input.ContinuationToken
      ? { Contents: [{ Key: `${prefix}${first}` }],IsTruncated: false }
      : { Contents: [{ Key: `${prefix}${second}` }],IsTruncated: true,NextContinuationToken: "next" };
    throw new Error("unexpected S3 command");
  } } as unknown as S3Client;
  expect(await listS3OwnerObjectIds(s3,"private-bucket",owner)).toEqual([first,second].sort());
  const unsafeS3 = { ...s3,async send(command: unknown) {
    if (command instanceof ListObjectsV2Command) return { Contents: [{ Key: `${prefix}nested/${first}` }],IsTruncated: false };
    return s3.send(command as never);
  } } as unknown as S3Client;
  await expect(listS3OwnerObjectIds(unsafeS3,"private-bucket",owner)).rejects.toThrow();

  const storage = { async getBucket(bucket: string) {
    expect(bucket).toBe(SUPABASE_UPLOAD_BUCKET);
    return { data: { id: bucket,public: false,file_size_limit: MAX_UPLOAD_BYTES,allowed_mime_types: ["application/octet-stream"] },error: null };
  },from(bucket: string) {
    expect(bucket).toBe(SUPABASE_UPLOAD_BUCKET);
    return { async list(path: string,options: { offset: number;limit: number }) {
      expect(path).toBe(prefix.slice(0,-1));expect(options.limit).toBe(100);
      return { data: options.offset ? [{ id: "last",name: second }] : Array.from({ length: 100 },(_,index) => ({
        id: `id-${index}`,name: index === 0 ? first : `00000000-0000-4000-8000-${String(index).padStart(12,"0")}` })),error: null };
    } };
  } } as unknown as Parameters<typeof listSupabaseOwnerObjectIds>[0];
  expect(await listSupabaseOwnerObjectIds(storage,owner)).toHaveLength(101);
  const folder = { ...storage,from: () => ({ list: async () => ({ data: [{ id: null,name: first }],error: null }) }) } as unknown as Parameters<typeof listSupabaseOwnerObjectIds>[0];
  await expect(listSupabaseOwnerObjectIds(folder,owner)).rejects.toThrow("folder");
});
