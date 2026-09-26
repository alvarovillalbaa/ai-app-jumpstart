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
const alice = "upload-alice-token-".repeat(3),bob = "upload-bob-token-".repeat(3),records = "records-only-token-".repeat(3),metadata = "upload-metadata-token-".repeat(3);
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

it("releases owner bytes only after an enabled fresh scan and stored-byte integrity check",async () => {
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("APP_API_KEYS",JSON.stringify([key(alice,"alice",["uploads:read","uploads:write","uploads:download"]),
    key(bob,"bob",["uploads:download"]),key(records,"alice",["records:read"]),key(metadata,"alice",["uploads:read"])]));
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-upload-download-"));
  const catalog = sqliteUploadCatalog(":memory:"),local = localUploadObjects(directory);
  let tampered = false;
  const objects = { ...local,get: async (...args: Parameters<typeof local.get>) => tampered
    ? new TextEncoder().encode("altered") : local.get(...args) };
  const scan = vi.fn(async (bytes: Uint8Array): Promise<"clean" | "infected"> => { expect(bytes.length).toBeGreaterThan(0);return "clean"; });
  const intake = uploadHandlers(async () => catalog,async () => objects);
  const api = uploadHandlers(async () => catalog,async () => objects,async () => ({ scan }));
  try {
    const payload = "private download payload";
    const created = await intake.create(new Request(root,{ method: "POST",body: Buffer.from(payload),headers: headers(alice,"owner's note.txt") }));
    const row = await created.json(),url = `${root}/${row.id}/download`;
    expect((await api.download(request(url,alice),row.id)).status).toBe(503);
    expect(scan).not.toHaveBeenCalled();
    vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","scan-on-read");
    vi.stubEnv("VERCEL","1");
    expect((await api.download(request(url,alice),row.id)).status).toBe(503);
    vi.stubEnv("VERCEL","");
    expect((await api.download(request(url,bob),row.id)).status).toBe(404);
    expect((await api.download(request(url,records),row.id)).status).toBe(403);
    expect((await api.download(request(url,metadata),row.id)).status).toBe(403);
    expect((await api.download(request(url,alice),randomUUID())).status).toBe(404);
    const noScanner = uploadHandlers(async () => catalog,async () => objects,async () => null);
    expect((await noScanner.download(request(url,alice),row.id)).status).toBe(503);
    tampered = true;
    const corrupt = await api.download(request(url,alice),row.id);
    expect(corrupt.status).toBe(503);
    expect((await corrupt.json()).error.code).toBe("upload_integrity_failed");
    expect(scan).not.toHaveBeenCalled();
    tampered = false;
    expect((await api.download(request(url,alice),row.id)).status).toBe(422);
    expect(await catalog.get({ tenant: "test",subject: "alice" },row.id)).toMatchObject({ state: "rejected",scan: { reason: "integrity" } });
    const infectedRow = await (await intake.create(new Request(root,{ method: "POST",body: Buffer.from(payload),headers: headers(alice,"owner's note.txt") }))).json();
    scan.mockResolvedValueOnce("infected");
    const infected = await api.download(request(`${root}/${infectedRow.id}/download`,alice),infectedRow.id);
    expect(infected.status).toBe(422);
    expect((await infected.json()).error.code).toBe("upload_rejected");
    expect((await api.download(request(`${root}/${infectedRow.id}/download`,alice),infectedRow.id)).status).toBe(422);
    expect(await catalog.get({ tenant: "test",subject: "alice" },infectedRow.id)).toMatchObject({ state: "rejected",scan: { reason: "malware" } });
    const cleanRow = await (await intake.create(new Request(root,{ method: "POST",body: Buffer.from(payload),headers: headers(alice,"owner's note.txt") }))).json();
    const clean = await api.download(request(`${root}/${cleanRow.id}/download`,alice),cleanRow.id);
    expect(clean.status).toBe(200);
    expect(clean.headers.get("content-type")).toBe("application/octet-stream");
    expect(clean.headers.get("content-disposition")).toContain("attachment;");
    expect(clean.headers.get("content-disposition")).toContain("owner%27s%20note.txt");
    expect(clean.headers.get("cache-control")).toBe("no-store");
    expect(clean.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await clean.text()).toBe(payload);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(await catalog.get({ tenant: "test",subject: "alice" },cleanRow.id)).toMatchObject({ state: "clean",scan: { status: "clean",policyVersion: 1 } });
    expect((await api.get(request(`${root}/${row.id}`,alice),row.id)).status).toBe(200);
  } finally { await catalog.close();await rm(directory,{ recursive: true,force: true }); }
});

it("bounds simultaneous download scans per owner and per process before reading objects",async () => {
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","scan-on-read");
  const tokens = Array.from({ length: 5 },(_,index) => `download-scan-token-${index}-`.repeat(3));
  vi.stubEnv("APP_API_KEYS",JSON.stringify(tokens.map((token,index) =>
    key(token,`owner-${index}`,["uploads:write","uploads:download"]))));
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-upload-admission-"));
  const catalog = sqliteUploadCatalog(":memory:"),local = localUploadObjects(directory);
  const get = vi.fn(local.get),objects = { ...local,get };
  const intake = uploadHandlers(async () => catalog,async () => objects);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const scan = vi.fn(async () => { await gate;return "clean" as const; });
  const api = uploadHandlers(async () => catalog,async () => objects,async () => ({ scan }));
  const pending: Promise<Response>[] = [];
  try {
    const ids: string[] = [];
    for (const token of tokens) {
      const created = await intake.create(request(root,token,"POST",Buffer.from("private")));
      expect(created.status).toBe(201);
      ids.push((await created.json()).id);
    }
    const download = (index: number) => api.download(request(`${root}/${ids[index]}/download`,tokens[index]),ids[index]);
    pending.push(download(0));
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1));
    expect((await download(0)).status).toBe(429);
    pending.push(download(1),download(2),download(3));
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(4));
    expect((await download(4)).status).toBe(429);
    expect(get).toHaveBeenCalledTimes(4);
    release();
    expect((await Promise.all(pending)).map(response => response.status)).toEqual([200,200,200,200]);
    expect((await download(4)).status).toBe(200);
    expect(get).toHaveBeenCalledTimes(5);
  } finally {
    release();await Promise.allSettled(pending);
    await catalog.close();await rm(directory,{ recursive: true,force: true });
  }
});

it("persists explicit owner scans without accepting caller verdicts or caching success through an outage",async () => {
  vi.stubEnv("AUTH_PROVIDER","api-key");vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","scan-on-read");
  vi.stubEnv("APP_API_KEYS",JSON.stringify([key(alice,"alice",["uploads:read","uploads:write","uploads:download"]),
    key(bob,"bob",["uploads:download"]),key(metadata,"alice",["uploads:read","uploads:write"])]));
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-explicit-upload-scan-"));
  const catalog = sqliteUploadCatalog(":memory:"),objects = localUploadObjects(directory),intake = uploadHandlers(async () => catalog,async () => objects);
  const scan = vi.fn(async (): Promise<"clean" | "infected"> => "clean"),api = uploadHandlers(async () => catalog,async () => objects,async () => ({ scan }));
  try {
    const row = await (await intake.create(request(root,alice,"POST",Buffer.from("private")))).json();
    const call = (token: string,body: object = {}) => api.scan(new Request(`${root}/${row.id}/scan`,{ method: "POST",body: JSON.stringify(body),headers: {
      authorization: `Bearer ${token}`,"content-type": "application/json" } }),row.id);
    expect((await call(metadata)).status).toBe(403);expect((await call(bob)).status).toBe(404);
    expect((await call(alice,{ verdict: "clean" })).status).toBe(400);expect(scan).not.toHaveBeenCalled();
    const clean = await call(alice);expect(clean.status).toBe(200);
    expect(await clean.json()).toMatchObject({ id: row.id,state: "clean",scan: { status: "clean",sha256: row.sha256,policyVersion: 1 } });
    scan.mockRejectedValueOnce(new Error("scanner URL secret"));
    const outage = await call(alice);expect(outage.status).toBe(503);expect(await outage.text()).not.toContain("secret");
    expect(await catalog.get({ tenant: "test",subject: "alice" },row.id)).toMatchObject({ state: "clean" });
    scan.mockResolvedValueOnce("infected");expect((await call(alice)).status).toBe(422);
    expect(await catalog.get({ tenant: "test",subject: "alice" },row.id)).toMatchObject({ state: "rejected",scan: { reason: "malware" } });
    expect((await call(alice)).status).toBe(422);expect(scan).toHaveBeenCalledTimes(3);
  } finally { await catalog.close();await rm(directory,{ recursive: true,force: true }); }
});

it("requires a current owner credential and fresh scan for short-lived digest-bound links",async () => {
  vi.stubEnv("AUTH_PROVIDER","api-key");vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","scan-on-read");
  const keys = [key(alice,"alice",["uploads:read","uploads:write","uploads:download"]),key(bob,"bob",["uploads:download"]),key(metadata,"alice",["uploads:read"])];
  vi.stubEnv("APP_API_KEYS",JSON.stringify(keys));
  vi.stubEnv("UPLOAD_DOWNLOAD_SIGNING_JSON",JSON.stringify({ audience: "test:uploads",activeKey: "v1",keys: { v1: "a".repeat(64) } }));
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-upload-link-http-"));
  const catalog = sqliteUploadCatalog(":memory:"),objects = localUploadObjects(directory);
  const scan = vi.fn(async (): Promise<"clean" | "infected"> => "clean"),reads = vi.fn(async () => objects);
  const intake = uploadHandlers(async () => catalog,async () => objects),api = uploadHandlers(async () => catalog,reads,async () => ({ scan }));
  let now = Date.now();const clock = vi.spyOn(Date,"now").mockImplementation(() => now);
  try {
    const row = await (await intake.create(request(root,alice,"POST",Buffer.from("private link payload")))).json();
    const linkRequest = (token: string,body: object = {}) => new Request(`${root}/${row.id}/download-link`,{
      method: "POST",headers: { authorization: `Bearer ${token}`,"content-type": "application/json" },body: JSON.stringify(body),
    });
    expect((await api.downloadLink(linkRequest(bob),row.id)).status).toBe(404);
    expect((await api.downloadLink(linkRequest(metadata),row.id)).status).toBe(403);
    expect((await api.downloadLink(linkRequest(alice,{ expiresAt: now+1_000_000 }),row.id)).status).toBe(400);
    const issued = await api.downloadLink(linkRequest(alice),row.id);
    expect(issued.status).toBe(200);expect(issued.headers.get("cache-control")).toBe("no-store");
    const link = await issued.json(),url = new URL(link.url,root).href;
    expect(link.expiresAt).toBe(now+60_000);expect(reads).not.toHaveBeenCalled();expect(scan).not.toHaveBeenCalled();
    expect((await api.download(new Request(url),row.id)).status).toBe(401);
    expect((await api.download(request(url,bob),row.id)).status).toBe(403);
    expect((await api.download(request(url,metadata),row.id)).status).toBe(403);
    expect((await api.download(request(url.replace(/grant=./,"grant=x"),alice),row.id)).status).toBe(403);
    expect((await api.download(request(`${root}/${row.id}/download?grant=`,alice),row.id)).status).toBe(403);
    expect((await api.download(request(url.replace("?grant=","?Grant="),alice),row.id)).status).toBe(400);
    expect((await api.download(request(url+"&grant=other",alice),row.id)).status).toBe(400);
    expect(reads).not.toHaveBeenCalled();
    const downloaded = await api.download(request(url,alice),row.id);
    expect(downloaded.status).toBe(200);expect(await downloaded.text()).toBe("private link payload");
    expect(scan).toHaveBeenCalledOnce();
    vi.stubEnv("APP_API_KEYS",JSON.stringify(keys.filter(item => item.subject !== "alice")));
    expect((await api.download(request(url,alice),row.id)).status).toBe(401);
    vi.stubEnv("APP_API_KEYS",JSON.stringify(keys.map(item => item.subject === "alice" ? { ...item,scopes: ["uploads:read"] } : item)));
    expect((await api.download(request(url,alice),row.id)).status).toBe(403);
    expect(scan).toHaveBeenCalledOnce();
    vi.stubEnv("APP_API_KEYS",JSON.stringify(keys));
    const changed = uploadHandlers(async () => ({ ...catalog,get: async (owner,id) => {
      const found = await catalog.get(owner,id);return found && { ...found,sha256: "b".repeat(64) };
    } }),reads,async () => ({ scan }));
    expect((await changed.download(request(url,alice),row.id)).status).toBe(403);
    expect(reads).toHaveBeenCalledOnce();
    now = link.expiresAt;
    expect((await api.download(request(url,alice),row.id)).status).toBe(410);expect(scan).toHaveBeenCalledOnce();
    const fresh = await (await api.downloadLink(linkRequest(alice),row.id)).json(),freshUrl = new URL(fresh.url,root).href;
    // Expiry while the daemon is working still withholds all bytes.
    scan.mockImplementationOnce(async () => { now = fresh.expiresAt;return "clean"; });
    expect((await api.download(request(freshUrl,alice),row.id)).status).toBe(410);
    const rejectionLink = await (await api.downloadLink(linkRequest(alice),row.id)).json();
    scan.mockResolvedValueOnce("infected");
    expect((await api.download(request(new URL(rejectionLink.url,root).href,alice),row.id)).status).toBe(422);
    expect((await api.downloadLink(linkRequest(alice),row.id)).status).toBe(422);
    expect((await api.delete(request(`${root}/${row.id}`,alice,"DELETE"),row.id)).status).toBe(204);
    expect((await api.download(request(new URL(rejectionLink.url,root).href,alice),row.id)).status).toBe(404);
  } finally { clock.mockRestore();await catalog.close();await rm(directory,{ recursive: true,force: true }); }
});
