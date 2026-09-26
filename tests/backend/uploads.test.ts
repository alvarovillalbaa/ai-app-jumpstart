import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uploadObjectKey } from "../../lib/uploads/contract";
import { localUploadObjects } from "../../lib/uploads/local";
import { checkUpload, MAX_UPLOAD_BYTES } from "../../lib/uploads/validation";
import { uploadObjectContract } from "../contracts/uploads";

const encoder = new TextEncoder();
const owner = { tenant: "tenant/private", subject: "alice@example.test" };
const other = { tenant: "tenant/private", subject: "bob@example.test" };
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path,{ recursive: true,force: true }))); });

it("accepts bounded inert UTF-8 text and rejects byte/type/path deception", () => {
  const source = encoder.encode("A private note\n");
  const checked = checkUpload("note.txt","text/plain",source);
  expect(checked).toMatchObject({ name: "note.txt",mediaType: "text/plain",size: source.length });
  expect(checked.sha256).toMatch(/^[a-f0-9]{64}$/);
  source[0] = 0;
  expect(new TextDecoder().decode(checked.bytes)).toBe("A private note\n");
  for (const [name,type,bytes] of [
    ["../note.txt","text/plain",encoder.encode("safe")],
    ["note.txt","text/html",encoder.encode("safe")],
    ["note.png","image/png",encoder.encode("not a PNG")],
    ["note.txt","text/plain",encoder.encode("<svg onload=alert(1)>")],
    ["note.txt","text/plain",Uint8Array.of(0xff,0xfe)],
    ["note.txt","text/plain",new Uint8Array(MAX_UPLOAD_BYTES+1)],
  ] as const) expect(() => checkUpload(name,type,bytes)).toThrow();
});

uploadObjectContract("local filesystem",async () => {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-uploads-"));directories.push(root);
  return { store: localUploadObjects(root),close: async () => {} };
});

it("uses opaque owner keys and private file permissions", async () => {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-uploads-"));directories.push(root);
  const store = localUploadObjects(root),id = randomUUID();
  const key = uploadObjectKey(owner,id);
  expect(key).not.toContain(owner.tenant);
  expect(key).not.toContain(owner.subject);
  expect(uploadObjectKey(other,id)).not.toBe(key);
  await expect(store.get(owner,"../../etc/passwd")).rejects.toBeDefined();
  await store.put(owner,id,encoder.encode("private"));
  expect((await stat(join(root,key))).mode & 0o777).toBe(0o600);
});

it("publishes one whole local object when concurrent writes race", async () => {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-uploads-"));directories.push(root);
  const store = localUploadObjects(root),id = randomUUID();
  const results = await Promise.allSettled([store.put(owner,id,encoder.encode("one")),store.put(owner,id,encoder.encode("two"))]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(["one","two"]).toContain(new TextDecoder().decode((await store.get(owner,id))!));
});

it("refuses a shared or symlinked local storage root", async () => {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-uploads-"));directories.push(root);
  await chmod(root,0o755);
  await expect(localUploadObjects(root).put(owner,randomUUID(),encoder.encode("private"))).rejects.toThrow("private directory");
  await chmod(root,0o700);
  const alias = `${root}-alias`;directories.push(alias);
  await symlink(root,alias);
  await expect(localUploadObjects(alias).put(owner,randomUUID(),encoder.encode("private"))).rejects.toThrow("private directory");
});
