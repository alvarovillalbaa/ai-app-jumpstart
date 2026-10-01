import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AppError } from "../../lib/http/errors";
import type { UploadCatalog } from "../../lib/uploads/catalog-contract";
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

it("admits one intake scan per owner and allows another owner to scan concurrently",async () => {
  const catalog = sqliteUploadCatalog(":memory:");
  const objects: PrivateUploadObjects = {
    async put() {},
    async get() { return null; },
    async delete() { return true; },
  };
  let release!: (verdict: "clean") => void;
  const gate = new Promise<"clean">(resolve => { release = resolve; });
  const scanner = { scan: vi.fn(async () => gate) };
  const pending: Promise<unknown>[] = [];
  try {
    const intake = new UploadIntake(catalog,objects,undefined,scanner);
    const first = intake.accept(owner,"first.txt","text/plain",encoder.encode("first"));pending.push(first);
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledTimes(1));
    await expect(intake.accept(owner,"second.txt","text/plain",encoder.encode("second")))
      .rejects.toMatchObject({ status: 429,code: "upload_scan_busy" });

    const otherOwnerScan = intake.accept(other,"other.txt","text/plain",encoder.encode("other"));pending.push(otherOwnerScan);
    await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledTimes(2));
    release("clean");
    const [firstEntry,otherEntry] = await Promise.all([first,otherOwnerScan]);
    expect(firstEntry.state).toBe("quarantined");
    expect(otherEntry.state).toBe("quarantined");
    expect(scanner.scan).toHaveBeenCalledTimes(2);
  } finally {
    release("clean");
    await Promise.allSettled(pending);
    await catalog.close();
  }
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

it("removes bytes when a permanent fence lands after upload reservation",async () => {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-fenced-intake-"));roots.push(root);
  const path = join(root,"app.sqlite"),catalog = sqliteUploadCatalog(path),stored = new Map<string,Uint8Array>();
  const log = vi.spyOn(console,"error").mockImplementation(() => {});
  let interruptedId = "";
  const objects: PrivateUploadObjects = {
    async put(forOwner,id,bytes) {
      interruptedId = id;
      stored.set(uploadObjectKey(forOwner,id),bytes);
      const db = new DatabaseSync(path);
      try { db.prepare("INSERT INTO app_account_fences(tenant,subject) VALUES(?,?)").run(forOwner.tenant,forOwner.subject); }
      finally { db.close(); }
    },
    async get(forOwner,id) { return stored.get(uploadObjectKey(forOwner,id)) ?? null; },
    async delete(forOwner,id) { return stored.delete(uploadObjectKey(forOwner,id)); },
  };
  try {
    const intake = new UploadIntake(catalog,objects);
    await expect(intake.accept(owner,"racing.txt","text/plain",encoder.encode("private"))).rejects.toThrow("fenced");
    expect(await catalog.isFenced(owner)).toBe(true);
    expect(await catalog.isFenced(other)).toBe(false);
    expect(stored.size).toBe(0);
    expect(await catalog.get(owner,interruptedId)).toMatchObject({ state: "pending" });
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "upload_cleanup_pending",uploadId: interruptedId }));
  } finally { log.mockRestore();await catalog.close(); }
});

it("skips object storage when a fence lands during the upload scan",async () => {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-fenced-scan-"));roots.push(root);
  const path = join(root,"app.sqlite"),catalog = sqliteUploadCatalog(path);
  const log = vi.spyOn(console,"error").mockImplementation(() => {});
  let writes = 0;
  const objects: PrivateUploadObjects = {
    async put() { writes++; },
    async get() { return null; },
    async delete() { return false; },
  };
  const scanner = { async scan() {
    const db = new DatabaseSync(path);
    try { db.prepare("INSERT INTO app_account_fences(tenant,subject) VALUES(?,?)").run(owner.tenant,owner.subject); }
    finally { db.close(); }
    return "clean" as const;
  } };
  try {
    const intake = new UploadIntake(catalog,objects,undefined,scanner);
    await expect(intake.accept(owner,"scan.txt","text/plain",encoder.encode("private")))
      .rejects.toMatchObject({ status: 409,code: "upload_conflict" });
    expect(writes).toBe(0);
    expect(await catalog.isFenced(owner)).toBe(true);
    expect(await catalog.usage(owner)).toEqual({ files: 1,bytes: 7 });
    expect(log).toHaveBeenCalledOnce();
  } finally { log.mockRestore();await catalog.close(); }
});

it("retains bytes paired with a quarantined row if a later read and fence interrupt intake",async () => {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-fenced-quarantine-"));roots.push(root);
  const path = join(root,"app.sqlite"),base = sqliteUploadCatalog(path),stored = new Map<string,Uint8Array>();
  const log = vi.spyOn(console,"error").mockImplementation(() => {});
  let interruptedId = "",firstRead = true;
  const catalog: UploadCatalog = { ...base,async get(forOwner,id) {
    if (firstRead) {
      firstRead = false;
      const db = new DatabaseSync(path);
      try { db.prepare("INSERT INTO app_account_fences(tenant,subject) VALUES(?,?)").run(forOwner.tenant,forOwner.subject); }
      finally { db.close(); }
      throw new Error("quarantine acknowledgement lost");
    }
    return base.get(forOwner,id);
  } };
  const objects: PrivateUploadObjects = {
    async put(forOwner,id,bytes) { interruptedId = id;stored.set(uploadObjectKey(forOwner,id),bytes); },
    async get(forOwner,id) { return stored.get(uploadObjectKey(forOwner,id)) ?? null; },
    async delete(forOwner,id) { return stored.delete(uploadObjectKey(forOwner,id)); },
  };
  try {
    await expect(new UploadIntake(catalog,objects).accept(owner,"stored.txt","text/plain",encoder.encode("private")))
      .rejects.toThrow("quarantine acknowledgement lost");
    expect(await base.get(owner,interruptedId)).toMatchObject({ state: "quarantined" });
    expect(stored.size).toBe(1);
    expect(log).toHaveBeenCalledOnce();
  } finally { log.mockRestore();await base.close(); }
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
