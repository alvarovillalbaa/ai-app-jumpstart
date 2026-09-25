import { randomUUID } from "node:crypto";
import { expect,it,vi } from "vitest";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { cleanupUploads } from "../../lib/uploads/cleanup";
import { uploadObjectKey,type PrivateUploadObjects } from "../../lib/uploads/contract";
import { STALE_PENDING_UPLOAD_MS } from "../../lib/uploads/intake";
import { uploadCleanupHandler } from "../../lib/http/upload-cleanup";

const owner = { tenant: "tenant",subject: "alice" };
const input = (createdAt: number) => ({ id: randomUUID(),name: "private.txt",mediaType: "text/plain" as const,
  size: 3,sha256: "a".repeat(64),createdAt });

it("cleans a bounded batch, holds quota on object failure and retries later",async () => {
  const now = Date.now(),catalog = sqliteUploadCatalog(":memory:"),stored = new Map<string,Uint8Array>();
  const pending = input(now-STALE_PENDING_UPLOAD_MS-2_000),deleting = input(now-STALE_PENDING_UPLOAD_MS-1_000),
    recent = input(now);
  let failId: string = deleting.id;
  const objects: PrivateUploadObjects = {
    async put(owner,id,bytes) { stored.set(uploadObjectKey(owner,id),bytes); },
    async get(owner,id) { return stored.get(uploadObjectKey(owner,id)) ?? null; },
    async delete(owner,id) { if (id === failId) throw new Error("object backend unavailable");
      return stored.delete(uploadObjectKey(owner,id)); },
  };
  try {
    for (const row of [pending,deleting,recent]) {
      expect(await catalog.reserve(owner,row,{ maxBytes: 9,maxFiles: 3 })).toBe("reserved");
      await objects.put(owner,row.id,new Uint8Array([1,2,3]));
    }
    expect(await catalog.beginDelete(owner,deleting.id)).toBe(true);
    expect(await cleanupUploads(catalog,objects,now,1)).toEqual({ scanned: 1,deleted: 1,skipped: 0,failed: 0,more: true });
    expect(await cleanupUploads(catalog,objects,now)).toEqual({ scanned: 1,deleted: 0,skipped: 0,failed: 1,more: false });
    expect(await catalog.get(owner,deleting.id)).toMatchObject({ state: "deleting" });
    expect(await catalog.usage(owner)).toEqual({ files: 2,bytes: 6 });
    failId = "";
    expect(await cleanupUploads(catalog,objects,now)).toEqual({ scanned: 1,deleted: 1,skipped: 0,failed: 0,more: false });
    expect(await catalog.get(owner,recent.id)).toMatchObject({ state: "pending" });
    expect(await catalog.usage(owner)).toEqual({ files: 1,bytes: 3 });
  } finally { await catalog.close(); }
});

it("requires a strong scheduler secret before touching upload providers",async () => {
  const catalog = vi.fn(),objects = vi.fn();
  const secret = "x".repeat(40);
  const request = (authorization?: string) => new Request("http://localhost/api/internal/uploads/cleanup",{
    headers: authorization ? { authorization } : {},
  });
  const disabled = uploadCleanupHandler(catalog,objects,() => undefined);
  expect((await disabled(request())).status).toBe(503);
  const handler = uploadCleanupHandler(catalog,objects,() => secret);
  expect((await handler(request())).status).toBe(401);
  expect((await handler(request(`Bearer ${"y".repeat(40)}`))).status).toBe(401);
  expect(catalog).not.toHaveBeenCalled();
  expect(objects).not.toHaveBeenCalled();
});

it("runs an authorized scheduled pass without returning private metadata",async () => {
  const catalog = sqliteUploadCatalog(":memory:"),row = input(1_000),secret = "s".repeat(40);
  const objects: PrivateUploadObjects = {
    async put() {},async get() { return null; },async delete() { return false; },
  };
  expect(await catalog.reserve(owner,row,{ maxBytes: 3,maxFiles: 1 })).toBe("reserved");
  const handler = uploadCleanupHandler(async () => catalog,async () => objects,() => secret,() => "supabase");
  const response = await handler(new Request("http://localhost/api/internal/uploads/cleanup",{
    headers: { authorization: `Bearer ${secret}` },
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = await response.text();
  expect(JSON.parse(body)).toEqual({ scanned: 1,deleted: 1,skipped: 0,failed: 0,more: false });
  expect(body).not.toContain(row.id);
  expect(body).not.toContain(owner.subject);
});

it("reports cleanup failure to the scheduler while preserving the reservation",async () => {
  const catalog = sqliteUploadCatalog(":memory:"),row = input(1_000),secret = "s".repeat(40);
  const objects: PrivateUploadObjects = {
    async put() {},async get() { return null; },async delete() { throw new Error("private backend failed"); },
  };
  expect(await catalog.reserve(owner,row,{ maxBytes: 3,maxFiles: 1 })).toBe("reserved");
  const handler = uploadCleanupHandler(async () => catalog,async () => objects,() => secret,() => "supabase");
  const response = await handler(new Request("http://localhost/api/internal/uploads/cleanup",{
    headers: { authorization: `Bearer ${secret}` },
  }));
  expect(response.status).toBe(503);
  const body = await response.text();
  expect(JSON.parse(body)).toMatchObject({ failed: 1,deleted: 0 });
  expect(body).not.toContain(row.id);
  expect(body).not.toContain(owner.subject);
});

it("acknowledges an authorized schedule without contacting providers when uploads are disabled",async () => {
  const catalog = vi.fn(),objects = vi.fn(),secret = "s".repeat(40);
  const handler = uploadCleanupHandler(catalog,objects,() => secret,() => undefined);
  const denied = await handler(new Request("http://localhost/api/internal/uploads/cleanup"));
  expect(denied.status).toBe(401);
  const response = await handler(new Request("http://localhost/api/internal/uploads/cleanup",{
    headers: { authorization: `Bearer ${secret}` },
  }));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ status: "storage_disabled" });
  expect(catalog).not.toHaveBeenCalled();
  expect(objects).not.toHaveBeenCalled();
});
