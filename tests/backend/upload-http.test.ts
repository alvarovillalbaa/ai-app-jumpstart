import { createHash,randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,expect,it,vi } from "vitest";
import { uploadHandlers,MAX_API_UPLOAD_BYTES } from "../../lib/http/uploads";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { localUploadObjects } from "../../lib/uploads/local";
import { STALE_PENDING_UPLOAD_MS } from "../../lib/uploads/intake";

const root = "http://localhost:3000/api/v1/uploads";
const alice = "upload-alice-token-".repeat(3),bob = "upload-bob-token-".repeat(3),records = "records-only-token-".repeat(3);
const key = (token: string,subject: string,scopes: string[]) => ({ sha256: createHash("sha256").update(token).digest("hex"),
  tenant: "test",subject,scopes });
const headers = (token: string,name = "private.txt") => ({ authorization: `Bearer ${token}`,
  "content-type": "application/octet-stream","x-upload-name": encodeURIComponent(name),"x-upload-media-type": "text/plain" });
const request = (url: string,token: string,method = "GET",body?: BodyInit) => new Request(url,{ method,body,
  headers: body ? headers(token) : { authorization: `Bearer ${token}` } });
afterEach(() => vi.unstubAllEnvs());

it("keeps raw bytes quarantined while exposing owner-only metadata, usage and deletion",async () => {
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("APP_API_KEYS",JSON.stringify([key(alice,"alice",["uploads:read","uploads:write"]),
    key(bob,"bob",["uploads:read","uploads:write"]),key(records,"alice",["records:read"])]));
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-upload-http-"));
  const catalog = sqliteUploadCatalog(":memory:"),objects = localUploadObjects(directory);
  const api = uploadHandlers(async () => catalog,async () => objects);
  try {
    const payload = "secret-payload-123";
    const unauth = await api.create(new Request(root,{ method: "POST",body: Buffer.from(payload),headers: headers("wrong") }));
    expect(unauth.status).toBe(401);
    const forbidden = await api.create(request(root,records,"POST",Buffer.from(payload)));
    expect(forbidden.status).toBe(403);
    const response = await api.create(request(root,alice,"POST",Buffer.from(payload)));
    expect(response.status).toBe(201);
    const row = await response.json();
    expect(row).toMatchObject({ name: "private.txt",state: "quarantined",size: payload.length });
    expect(response.headers.get("location")).toBe(`/api/v1/uploads/${row.id}`);
    expect(await (await api.list(request(root,bob))).json()).toEqual({ items: [],usage: { files: 0,bytes: 0 } });
    const ownList = await (await api.list(request(root,alice))).json();
    expect(ownList).toMatchObject({ items: [{ id: row.id,state: "quarantined" }],usage: { files: 1,bytes: payload.length } });
    expect(JSON.stringify(ownList)).not.toContain(payload);
    expect(new TextDecoder().decode((await objects.get({ tenant: "test",subject: "alice" },row.id))!)).toBe(payload);
    expect((await api.get(request(`${root}/${row.id}`,bob),row.id)).status).toBe(404);
    expect((await api.delete(request(`${root}/${row.id}`,bob,"DELETE"),row.id)).status).toBe(404);
    expect((await api.delete(request(`${root}/${row.id}`,alice,"DELETE"),row.id)).status).toBe(204);
    expect(await objects.get({ tenant: "test",subject: "alice" },row.id)).toBeNull();
    expect((await api.get(request(`${root}/${row.id}`,alice),row.id)).status).toBe(404);
  } finally { await catalog.close();await rm(directory,{ recursive: true,force: true }); }
});

it("lets an owner remove an abandoned pending upload after the grace period",async () => {
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("APP_API_KEYS",JSON.stringify([key(alice,"alice",["uploads:read","uploads:write"]),
    key(bob,"bob",["uploads:read","uploads:write"])]));
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-upload-recovery-"));
  const catalog = sqliteUploadCatalog(":memory:"),objects = localUploadObjects(directory),api = uploadHandlers(async () => catalog,async () => objects);
  const owner = { tenant: "test",subject: "alice" },quota = { maxBytes: 10,maxFiles: 2 };
  const old = { id: randomUUID(),name: "old.txt",mediaType: "text/plain" as const,size: 6,sha256: "a".repeat(64),
    createdAt: Date.now()-STALE_PENDING_UPLOAD_MS-1_000 };
  const recent = { ...old,id: randomUUID(),size: 4,createdAt: Date.now() };
  try {
    expect(await catalog.reserve(owner,old,quota)).toBe("reserved");
    expect(await catalog.reserve(owner,recent,quota)).toBe("reserved");
    await objects.put(owner,old.id,new TextEncoder().encode("secret"));
    expect((await api.delete(request(`${root}/${recent.id}`,alice,"DELETE"),recent.id)).status).toBe(409);
    expect((await api.delete(request(`${root}/${old.id}`,bob,"DELETE"),old.id)).status).toBe(404);
    expect((await api.delete(request(`${root}/${old.id}`,alice,"DELETE"),old.id)).status).toBe(204);
    expect(await objects.get(owner,old.id)).toBeNull();
    expect(await catalog.get(owner,old.id)).toMatchObject({ state: "deleted" });
    expect(await catalog.get(owner,recent.id)).toMatchObject({ state: "pending" });
    expect(await catalog.usage(owner)).toEqual({ files: 1,bytes: 4 });
  } finally { await catalog.close();await rm(directory,{ recursive: true,force: true }); }
});

it("rejects invalid content and oversized streams before any quota reservation",async () => {
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("APP_API_KEYS",JSON.stringify([key(alice,"alice",["uploads:read","uploads:write"])]));
  const catalog = sqliteUploadCatalog(":memory:"),objects = { put: vi.fn(),get: vi.fn(),delete: vi.fn() };
  const api = uploadHandlers(async () => catalog,async () => objects);
  try {
    const invalid = await api.create(new Request(root,{ method: "POST",body: Buffer.from("<svg/>"),headers: headers(alice) }));
    expect(invalid.status).toBe(400);
    const active = await api.create(new Request(root,{ method: "POST",body: Buffer.from("hello"),headers: headers(alice,"active.svg") }));
    expect(active.status).toBe(400);
    const deniedType = await api.create(new Request(root,{ method: "POST",body: Buffer.from("hello"),headers: {
      ...headers(alice),"content-encoding": "gzip" } }));
    expect(deniedType.status).toBe(415);
    const tooLarge = await api.create(new Request(root,{ method: "POST",body: Buffer.alloc(MAX_API_UPLOAD_BYTES+1),headers: headers(alice) }));
    expect(tooLarge.status).toBe(413);
    const id = randomUUID(),missing = await api.get(request(`${root}/${id}`,alice),id);
    expect(missing.status).toBe(404);
    expect((await catalog.usage({ tenant: "test",subject: "alice" })).files).toBe(0);
    expect(objects.put).not.toHaveBeenCalled();
  } finally { await catalog.close(); }
});

it("keeps metadata readable while a configured scanner rejects or is unavailable",async () => {
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("APP_API_KEYS",JSON.stringify([key(alice,"alice",["uploads:read","uploads:write"])]));
  const catalog = sqliteUploadCatalog(":memory:"),objects = { put: vi.fn(async () => {}),get: vi.fn(async () => null),delete: vi.fn(async () => false) };
  const scan = vi.fn().mockResolvedValueOnce("infected").mockRejectedValueOnce(new Error("daemon down"));
  const api = uploadHandlers(async () => catalog,async () => objects,async () => ({ scan }));
  try {
    const infected = await api.create(request(root,alice,"POST",Buffer.from("test")));
    expect(infected.status).toBe(422);
    expect((await infected.json()).error).toMatchObject({ code: "upload_rejected" });
    const unavailable = await api.create(request(root,alice,"POST",Buffer.from("test")));
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error).toMatchObject({ code: "scanner_unavailable" });
    expect(await (await api.list(request(root,alice))).json()).toEqual({ items: [],usage: { files: 0,bytes: 0 } });
    expect(objects.put).not.toHaveBeenCalled();
    expect(objects.delete).not.toHaveBeenCalled();
  } finally { await catalog.close(); }
});
