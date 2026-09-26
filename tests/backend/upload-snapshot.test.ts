import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { createPostgresDatabaseSet, restorePostgresUploadSnapshot, verifyPostgresDatabaseSet } from "../../scripts/backup-postgres-databases.mjs";
import { copyUploadSnapshot, describeUploadSnapshot } from "../../scripts/private-upload-snapshot.mjs";
import { localUploadObjects } from "../../lib/uploads/local";
import { uploadObjectKey } from "../../lib/uploads/contract";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "jumpstart-upload-snapshot-")); roots.push(root);
  const source = join(root, "source");
  const owner = { tenant: "snapshot", subject: "alice" }, id = randomUUID();
  const payload = Buffer.alloc(150_000, 37); // Multiple streaming chunks.
  await localUploadObjects(source).put(owner, id, payload);
  return { root, source, owner, id, payload };
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>, included = true) {
  const output = join(f.root, "snapshot");
  await mkdir(output, { mode: 0o700 });
  const files = [];
  for (const name of ["application.dump", "workflow.dump"]) {
    const bytes = Buffer.from(`isolated-${name}`);
    await writeFile(join(output, name), bytes, { mode: 0o600 });
    files.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  if (included) {
    await copyUploadSnapshot(f.source, join(output, "uploads"));
    files.push(...await describeUploadSnapshot(join(output, "uploads")));
  }
  const manifest = { format: "jumpstart-postgres-databases", version: 2, createdAt: new Date().toISOString(),
    restoreVerified: false, uploads: included ? "included" : "excluded", files };
  await writeFile(join(output, "manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
  return { output, manifest };
}

it("restores a hashed database set's local objects to a new private root with owner isolation", async () => {
  const f = await fixture(), s = await snapshot(f), destination = join(f.root, "restored");
  expect(await verifyPostgresDatabaseSet(s.output)).toMatchObject({ files: 3, uploads: "included", uploadFiles: 1 });
  expect(await restorePostgresUploadSnapshot(s.output, destination)).toMatchObject({ uploadFiles: 1 });
  const objects = localUploadObjects(destination);
  expect(Buffer.from((await objects.get(f.owner, f.id))!)).toEqual(f.payload);
  expect(await objects.get({ ...f.owner, subject: "bob" }, f.id)).toBeNull();
  expect((await stat(destination)).mode & 0o777).toBe(0o700);
  expect((await stat(join(destination, uploadObjectKey(f.owner, f.id)))).mode & 0o777).toBe(0o600);
  await expect(restorePostgresUploadSnapshot(s.output, destination)).rejects.toThrow();
  expect(Buffer.from((await objects.get(f.owner, f.id))!)).toEqual(f.payload);
  await expect(restorePostgresUploadSnapshot(s.output, join(s.output, "nested"))).rejects.toThrow("separate");
});

it("rejects changed bytes, extra files and traversal without creating a restore root", async () => {
  const f = await fixture(), s = await snapshot(f), destination = join(f.root, "restored");
  const object = join(s.output, "uploads", uploadObjectKey(f.owner, f.id));
  await writeFile(object, "changed");
  await expect(restorePostgresUploadSnapshot(s.output, destination)).rejects.toThrow("hashes or sizes");
  expect(await stat(destination).then(() => true, () => false)).toBe(false);
  await writeFile(object, f.payload);
  await writeFile(join(s.output, "extra"), "unexpected", { mode: 0o600 });
  await expect(verifyPostgresDatabaseSet(s.output)).rejects.toThrow("unexpected files");
  await rm(join(s.output, "extra"));
  s.manifest.files[2].name = "uploads/../../private-secret";
  await writeFile(join(s.output, "manifest.json"), JSON.stringify(s.manifest));
  await expect(verifyPostgresDatabaseSet(s.output)).rejects.toThrow("invalid file entry");
});

it("refuses symlinked roots, symlinked objects and nonprivate data", async () => {
  const f = await fixture(), linked = join(f.root, "linked"), destination = join(f.root, "copy");
  await symlink(f.source, linked);
  await expect(copyUploadSnapshot(linked, destination)).rejects.toThrow("private, real directory");
  const object = join(f.source, uploadObjectKey(f.owner, f.id));
  await chmod(object, 0o644);
  await expect(copyUploadSnapshot(f.source, destination)).rejects.toThrow("readable by other users");
  await chmod(object, 0o600);
  const outside = join(f.root, "outside");
  await writeFile(outside, "outside bytes", { mode: 0o600 });
  await rm(object); await symlink(outside, object);
  await expect(copyUploadSnapshot(f.source, destination)).rejects.toThrow("symlinks");
  expect(await stat(destination).then(() => true, () => false)).toBe(false);
  expect(await readFile(outside, "utf8")).toBe("outside bytes");
});

it("refuses incomplete local writes and retains an empty object root", async () => {
  const f = await fixture(), object = join(f.source, uploadObjectKey(f.owner, f.id));
  await writeFile(join(dirname(object), ".abandoned.tmp"), "partial", { mode: 0o600 });
  await expect(copyUploadSnapshot(f.source, join(f.root, "copy"))).rejects.toThrow("incomplete writes");
  await rm(join(dirname(object), ".abandoned.tmp")); await rm(object);
  await copyUploadSnapshot(f.source, join(f.root, "empty"));
  expect(await describeUploadSnapshot(join(f.root, "empty"))).toEqual([]);
});

it("distinguishes excluded objects and old untracked sets, and refuses either as an object restore", async () => {
  const f = await fixture(), s = await snapshot(f, false);
  expect(await verifyPostgresDatabaseSet(s.output)).toMatchObject({ uploads: "excluded", uploadFiles: 0 });
  await expect(restorePostgresUploadSnapshot(s.output, join(f.root, "restored"))).rejects.toThrow("does not include");
  await writeFile(join(s.output, "manifest.json"), JSON.stringify({ ...s.manifest, version: 1, uploads: undefined }));
  expect(await verifyPostgresDatabaseSet(s.output)).toMatchObject({ uploads: "untracked", uploadFiles: 0 });
  await expect(restorePostgresUploadSnapshot(s.output, join(f.root, "restored"))).rejects.toThrow("does not include");
});

it("requires the configured local root and refuses source/destination overlap before contacting databases", async () => {
  const f = await fixture();
  const input = { applicationUrl: "postgresql://user:private-password@127.0.0.1/app",
    workflowUrl: "postgresql://user:private-password@127.0.0.1/workflow", stopped: true, output: join(f.root, "set") };
  await expect(createPostgresDatabaseSet({ ...input, env: { UPLOAD_STORAGE_PROVIDER: "local" } })).rejects.toThrow("must be included");
  await expect(createPostgresDatabaseSet({ ...input, uploadsDir: f.source, env: { UPLOAD_STORAGE_PROVIDER: "supabase" } })).rejects.toThrow("remote object storage");
  await expect(createPostgresDatabaseSet({ ...input, uploadsDir: f.source, env: { UPLOAD_LOCAL_ROOT: f.root } })).rejects.toThrow("does not match");
  await expect(createPostgresDatabaseSet({ ...input, uploadsDir: f.source, output: join(f.source, "set"), env: {} })).rejects.toThrow("must be separate");
  expect(await stat(input.output).then(() => true, () => false)).toBe(false);
});
