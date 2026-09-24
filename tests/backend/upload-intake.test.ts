import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AppError } from "../../lib/http/errors";
import { uploadObjectKey, type PrivateUploadObjects } from "../../lib/uploads/contract";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { UploadIntake } from "../../lib/uploads/intake";
import { localUploadObjects } from "../../lib/uploads/local";

const owner = { tenant: "tenant",subject: "alice" },other = { tenant: "tenant",subject: "bob" };
const encoder = new TextEncoder();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root,{ recursive: true,force: true }))); });

it("quarantines checked bytes and deletes only the owner's object",async () => {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-intake-"));roots.push(root);
  const catalog = sqliteUploadCatalog(":memory:"),objects = localUploadObjects(root);
  try {
    const intake = new UploadIntake(catalog,objects),entry = await intake.accept(owner,"private.txt","text/plain",encoder.encode("private"));
    expect(entry.state).toBe("quarantined");
    expect(await intake.usage(owner)).toEqual({ files: 1,bytes: 7 });
    expect(await intake.get(other,entry.id)).toBeNull();
    expect(new TextDecoder().decode((await objects.get(owner,entry.id))!)).toBe("private");
    expect(await intake.remove(other,entry.id)).toBe(false);
    expect(await intake.remove(owner,entry.id)).toBe(true);
    expect(await intake.get(owner,entry.id)).toMatchObject({ state: "deleted" });
    expect(await objects.get(owner,entry.id)).toBeNull();
    expect(await intake.usage(owner)).toEqual({ files: 0,bytes: 0 });
  } finally { await catalog.close(); }
});

it("lets exactly one concurrent intake write under the atomic catalog quota",async () => {
  const catalog = sqliteUploadCatalog(":memory:"),stored = new Map<string,Uint8Array>();
  let writes = 0;
  const objects: PrivateUploadObjects = {
    async put(owner,id,bytes) { writes++;stored.set(uploadObjectKey(owner,id),bytes); },
    async get(owner,id) { return stored.get(uploadObjectKey(owner,id)) ?? null; },
    async delete(owner,id) { return stored.delete(uploadObjectKey(owner,id)); },
  };
  try {
    const intake = new UploadIntake(catalog,objects,{ maxBytes: 8,maxFiles: 1 });
    const results = await Promise.allSettled([intake.accept(owner,"one.txt","text/plain",encoder.encode("one")),
      intake.accept(owner,"two.txt","text/plain",encoder.encode("two"))]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(writes).toBe(1);
    expect(stored.size).toBe(1);
  } finally { await catalog.close(); }
});

it("compensates an ambiguous blob write, and holds quota if cleanup fails",async () => {
  const log = vi.spyOn(console,"error").mockImplementation(() => {});
  const catalog = sqliteUploadCatalog(":memory:"),stored = new Map<string,Uint8Array>();
  let failWrite = true,failDelete = true;
  const objects: PrivateUploadObjects = {
    async put(owner,id,bytes) { stored.set(uploadObjectKey(owner,id),bytes);if (failWrite) throw new Error("write acknowledgement lost"); },
    async get(owner,id) { return stored.get(uploadObjectKey(owner,id)) ?? null; },
    async delete(owner,id) { if (failDelete) { failDelete = false;throw new Error("temporary delete failure"); }
      return stored.delete(uploadObjectKey(owner,id)); },
  };
  try {
    const intake = new UploadIntake(catalog,objects,{ maxBytes: 8,maxFiles: 1 });
    await expect(intake.accept(owner,"one.txt","text/plain",encoder.encode("one"))).rejects.toThrow("write acknowledgement lost");
    expect(await intake.usage(owner)).toEqual({ files: 1,bytes: 3 });
    expect(stored.size).toBe(1);
    await expect(intake.accept(owner,"two.txt","text/plain",encoder.encode("two")))
      .rejects.toMatchObject({ status: 429,code: "upload_quota" } satisfies Partial<AppError>);
    const [key] = stored.keys(),id = key.split("/").at(-1)!;
    expect(await intake.get(owner,id)).toMatchObject({ state: "deleting" });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "upload_cleanup_pending",uploadId: id }));
    expect(await intake.remove(owner,id)).toBe(true);
    expect(stored.size).toBe(0);
    expect(await intake.usage(owner)).toEqual({ files: 0,bytes: 0 });
    failWrite = false;
    await expect(intake.accept(owner,"bad.svg","image/svg+xml",encoder.encode("<svg/>"))).rejects.toBeDefined();
    expect(await intake.usage(owner)).toEqual({ files: 0,bytes: 0 });
  } finally { log.mockRestore();await catalog.close(); }
});

it("holds quota after a failed stale-pending cleanup and permits deletion retry",async () => {
  const catalog = sqliteUploadCatalog(":memory:"),stored = new Map<string,Uint8Array>();
  const row = { id: randomUUID(),name: "old.txt",mediaType: "text/plain" as const,size: 6,
    sha256: "a".repeat(64),createdAt: 1_000 };
  let failDelete = true;
  const objects: PrivateUploadObjects = {
    async put(owner,id,bytes) { stored.set(uploadObjectKey(owner,id),bytes); },
    async get(owner,id) { return stored.get(uploadObjectKey(owner,id)) ?? null; },
    async delete(owner,id) { if (failDelete) { failDelete = false;throw new Error("storage unavailable"); }
      return stored.delete(uploadObjectKey(owner,id)); },
  };
  try {
    const intake = new UploadIntake(catalog,objects);
    expect(await catalog.reserve(owner,row,{ maxBytes: 6,maxFiles: 1 })).toBe("reserved");
    await objects.put(owner,row.id,encoder.encode("secret"));
    await expect(intake.removeStalePending(other,row.id,2_000)).resolves.toBe(false);
    await expect(intake.removeStalePending(owner,row.id,2_000)).rejects.toThrow("storage unavailable");
    expect(await catalog.get(owner,row.id)).toMatchObject({ state: "deleting" });
    expect(await catalog.usage(owner)).toEqual({ files: 1,bytes: 6 });
    expect(await intake.remove(owner,row.id)).toBe(true);
    expect(stored.size).toBe(0);
    expect(await catalog.usage(owner)).toEqual({ files: 0,bytes: 0 });
  } finally { await catalog.close(); }
});
