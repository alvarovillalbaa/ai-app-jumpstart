import { createHash,randomUUID } from "node:crypto";
import { mkdtempSync,readFileSync,readdirSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterEach,beforeAll, expect, it,vi } from "vitest";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { uploadObjectKey, type PrivateUploadObjects } from "../../lib/uploads/contract";
import { SUPABASE_UPLOAD_BUCKET, supabaseUploadObjects, uploadStorageClient, verifyPrivateUploadBucket } from "../../lib/uploads/supabase";
import { verifyUploadStoragePolicy } from "../../lib/uploads/storage-policy";
import { supabaseUploadCatalog } from "../../lib/uploads/catalog-remote";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { UploadIntake } from "../../lib/uploads/intake";
import { localUploadObjects } from "../../lib/uploads/local";
import { uploadObjectContract } from "../contracts/uploads";
import { uploadHandlers } from "../../lib/http/uploads";
import { inspectSupabaseOwnerObjects } from "../../lib/uploads/object-inventory";
import { exportAccountObjects } from "../../scripts/export-account-objects";
import { listSupabaseOwnerObjectIds } from "../../lib/uploads/object-export";
import { verifyExport } from "../../scripts/verify-export";
import { exportAccountBundle,verifyAccountBundle } from "../../scripts/export-account-bundle";
import { setPostgresAccountFence,setSqliteAccountFence } from "../../scripts/fence-account-writes";
import { rehearseAccountBundle,verifyRehearsedAccountBundle } from "../../scripts/rehearse-account-bundle";

const url = process.env.SUPABASE_URL,secret = process.env.SUPABASE_SECRET_KEY,anonKey = process.env.SUPABASE_ANON_KEY;
const database = process.env.DATABASE_URL;
if (!url || !secret || !anonKey || !database) throw new Error("Live Storage tests require local Supabase URL, backend secret, anon key and database URL.");
const storage = uploadStorageClient(url,secret).storage;
const raw = supabaseUploadObjects(storage);
beforeAll(async () => { await verifyUploadStoragePolicy(database);await verifyPrivateUploadBucket(storage); });
afterEach(() => vi.unstubAllEnvs());

function requireDisposableDatabase() {
  if (!database || !url) throw new Error("Account bundle fixture requires disposable services.");
  const target = new URL(database);
  const service = new URL(url);
  if (!["127.0.0.1","localhost","[::1]"].includes(target.hostname) || target.pathname !== "/app_data_test" ||
      service.protocol !== "http:" || !["127.0.0.1","localhost","[::1]"].includes(service.hostname))
    throw new Error("Account bundle fixture requires disposable loopback services.");
}

// Only the owned Auth harness adds a broad policy; never modify a configured
// project's RLS to enable this positive control.
if (process.env.TEST_STORAGE_PERMISSIVE === "1") it("allows an unrelated bucket through the fixture policy while quarantine stays private",async () => {
  const bucket = `control-${randomUUID()}`,key = "control.txt";
  const anon = createClient(url,anonKey,{ auth: { persistSession: false,autoRefreshToken: false } });
  expect((await storage.createBucket(bucket,{ public: false })).error).toBeNull();
  try {
    expect((await anon.storage.from(bucket).upload(key,new Blob(["control"]),{ contentType: "application/octet-stream" })).error).toBeNull();
    const found = await anon.storage.from(bucket).download(key);
    expect(found.error).toBeNull();expect(await found.data!.text()).toBe("control");
  } finally {
    const removed = await storage.from(bucket).remove([key]);expect(removed.error).toBeNull();
    expect((await storage.deleteBucket(bucket)).error).toBeNull();
  }
});

if (process.env.TEST_DISPOSABLE_SUPABASE === "1") it("bundles real Supabase catalog rows and Storage bytes for one fenced owner",async () => {
  requireDisposableDatabase();
  const owner = { tenant: randomUUID(),subject: "bundle-owner" },other = { tenant: owner.tenant,subject: "other" };
  const mismatchOwner = { tenant: randomUUID(),subject: "bundle-mismatch" };
  const orphan = randomUUID(),foreign = randomUUID(),mismatch = randomUUID();
  const bytes = new TextEncoder().encode("real managed account bytes"),dir = mkdtempSync(join(tmpdir(),"jumpstart-managed-bundle-"));
  const catalog = supabaseUploadCatalog(url,secret),intake = new UploadIntake(catalog,raw);
  const pg = new Client({ connectionString: database,connectionTimeoutMillis: 5_000 });
  let activeId: string | undefined;
  try {
    await pg.connect();
    activeId = (await intake.accept(owner,"owned.txt","text/plain",bytes)).id;
    await raw.put(owner,orphan,new TextEncoder().encode("catalog orphan bytes"));
    await raw.put(other,foreign,new TextEncoder().encode("foreign owner bytes"));
    const env = { DATABASE_URL: database,SUPABASE_URL: url,SUPABASE_SECRET_KEY: secret };
    await expect(exportAccountBundle("postgres","supabase",owner,join(dir,"unfenced"),env))
      .rejects.toThrow("fenced");
    expect(readdirSync(dir)).not.toContain("unfenced");
    expect((await setPostgresAccountFence(database,owner)).created).toBe(true);
    const output = join(dir,"bundle");
    expect(await exportAccountBundle("postgres","supabase",owner,output,env)).toEqual({
      metadataProvider: "postgres",objectProvider: "supabase",rows: 1,objects: 2,
      catalog: { catalogRows: 1,activeRows: 1,objectOrphans: 1,transitionalWithoutBytes: 0 } });
    expect(await verifyAccountBundle(output)).toMatchObject({ rows: 1,objects: 2 });
    const archived = readFileSync(join(output,"objects.ndjson"),"utf8");
    expect(archived).toContain(orphan);
    expect(archived).not.toContain(foreign);

    const intended = new TextEncoder().encode("expected bytes");
    expect(await catalog.reserve(mismatchOwner,{ id: mismatch,name: "mismatch.txt",mediaType: "text/plain",
      size: intended.length,sha256: createHash("sha256").update(intended).digest("hex"),createdAt: Date.now() },
      { maxBytes: 1000,maxFiles: 1 })).toBe("reserved");
    await raw.put(mismatchOwner,mismatch,new TextEncoder().encode("different data"));
    expect(await catalog.markStored(mismatchOwner,mismatch)).toBe(true);
    expect((await setPostgresAccountFence(database,mismatchOwner)).created).toBe(true);
    await expect(exportAccountBundle("postgres","supabase",mismatchOwner,join(dir,"mismatch"),env))
      .rejects.toThrow("differs from its catalog row");
    expect(readdirSync(dir)).not.toContain("mismatch");
  } finally {
    await Promise.allSettled([...(activeId ? [raw.delete(owner,activeId)] : []),raw.delete(owner,orphan),
      raw.delete(other,foreign),raw.delete(mismatchOwner,mismatch)]);
    if (activeId) await pg.query("DELETE FROM public.app_uploads WHERE id=$1",[activeId]).catch(() => {});
    await pg.query("DELETE FROM public.app_uploads WHERE id=$1",[mismatch]).catch(() => {});
    await pg.end().catch(() => {});
    await catalog.close();
    rmSync(dir,{ recursive: true,force: true });
  }
},60_000);

if (process.env.TEST_DISPOSABLE_SUPABASE === "1") it("rehearses SQLite account rows and real Supabase Storage bytes into isolated local storage",async () => {
  requireDisposableDatabase();
  const owner = { tenant: randomUUID(),subject: "portable-bundle" },other = { ...owner,subject: "other" };
  const id = randomUUID(),orphan = randomUUID(),foreign = randomUUID();
  const bytes = new TextEncoder().encode("portable real Storage bytes");
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-portable-bundle-"));
  const path = join(dir,"app.sqlite"),bundle = join(dir,"bundle"),rehearsal = join(dir,"rehearsal");
  try {
    const stores = [new SqliteRepository(path),sqliteAccessStore(path),sqliteBudgetStore(path),
      sqlitePreferenceStore(path),sqliteRequestLimitStore(path)];
    for (const store of stores) await store.close();
    const catalog = sqliteUploadCatalog(path);
    try {
      expect(await catalog.reserve(owner,{ id,name: "portable.txt",mediaType: "text/plain",size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),createdAt: Date.now() },
      { maxBytes: 1000,maxFiles: 1 })).toBe("reserved");
      await raw.put(owner,id,bytes);
      expect(await catalog.markStored(owner,id)).toBe(true);
    } finally { await catalog.close(); }
    await raw.put(owner,orphan,new TextEncoder().encode("portable orphan bytes"));
    await raw.put(other,foreign,new TextEncoder().encode("foreign bytes"));
    setSqliteAccountFence(path,owner);
    expect(await exportAccountBundle("sqlite","supabase",owner,bundle,
      { ACCOUNT_AUDIT_SQLITE_PATH: path,SUPABASE_URL: url,SUPABASE_SECRET_KEY: secret })).toMatchObject({
      metadataProvider: "sqlite",objectProvider: "supabase",rows: 1,objects: 2 });
    expect(await rehearseAccountBundle(bundle,rehearsal)).toEqual({
      provider: "sqlite",rows: 1,objects: 2,status: "fenced-rehearsal" });
    expect(await verifyRehearsedAccountBundle(bundle,rehearsal)).toMatchObject({ rows: 1,objects: 2 });
    const local = localUploadObjects(join(rehearsal,"uploads"));
    expect(await local.get(owner,id)).toEqual(Buffer.from(bytes));
    expect(await local.get(owner,orphan)).toEqual(Buffer.from("portable orphan bytes"));
    expect(await local.get(other,foreign)).toBeNull();
  } finally {
    await Promise.allSettled([raw.delete(owner,id),raw.delete(owner,orphan),raw.delete(other,foreign)]);
    rmSync(dir,{ recursive: true,force: true });
  }
},60_000);

uploadObjectContract("live Supabase Storage",async () => {
  const created: Array<{ owner: Parameters<PrivateUploadObjects["put"]>[0];id: string }> = [];
  const store: PrivateUploadObjects = {
    async put(owner,id,bytes) { await raw.put(owner,id,bytes);created.push({ owner,id }); },
    get: (owner,id) => raw.get(owner,id),delete: (owner,id) => raw.delete(owner,id),
  };
  return { store,close: async () => { for (const { owner,id } of created) await raw.delete(owner,id); } };
});

it("counts real private objects even without catalog rows and observes their removal",async () => {
  const owner = { tenant: randomUUID(),subject: "operator-audit" },id = randomUUID(),dir = mkdtempSync(join(tmpdir(),"jumpstart-storage-export-"));
  await raw.put(owner,id,new TextEncoder().encode("unlinked private bytes"));
  try {
    expect(await inspectSupabaseOwnerObjects(storage,owner)).toBe(1);
    expect(await inspectSupabaseOwnerObjects(storage,{ ...owner,subject: "other" })).toBe(0);
    const result = await exportAccountObjects({ list: () => listSupabaseOwnerObjectIds(storage,owner),
      get: objectId => raw.get(owner,objectId) },join(dir,"private.ndjson"),"supabase");
    expect(result).toEqual({ objects: 1 });
    expect(await verifyExport(join(dir,"private.ndjson"))).toMatchObject({ counts: { objects: 1 } });
  } finally { await raw.delete(owner,id);rmSync(dir,{ recursive: true,force: true }); }
  expect(await inspectSupabaseOwnerObjects(storage,owner)).toBe(0);
});

it("denies anonymous Storage operations and public downloads for a private object",async () => {
  const owner = { tenant: randomUUID(),subject: "alice" },id = randomUUID(),key = uploadObjectKey(owner,id);
  const anon = createClient(url,anonKey,{ auth: { persistSession: false,autoRefreshToken: false } });
  await raw.put(owner,id,new TextEncoder().encode("private"));
  try {
    expect((await anon.storage.from(SUPABASE_UPLOAD_BUCKET).download(key)).error).not.toBeNull();
    expect((await anon.storage.from(SUPABASE_UPLOAD_BUCKET).upload(key,new Blob(["forged"]),{ upsert: true })).error).not.toBeNull();
    await anon.storage.from(SUPABASE_UPLOAD_BUCKET).remove([key]);
    expect((await anon.storage.from(SUPABASE_UPLOAD_BUCKET).list(key.split("/").slice(0,-1).join("/"))).data?.some(item => item.name === id)).not.toBe(true);
    const publicUrl = anon.storage.from(SUPABASE_UPLOAD_BUCKET).getPublicUrl(key).data.publicUrl;
    expect((await fetch(publicUrl)).ok).toBe(false);
    expect(new TextDecoder().decode((await raw.get(owner,id))!)).toBe("private");
  } finally { await raw.delete(owner,id); }
});

it("admits one writer through real Supabase metadata and Storage under a concurrent quota race",async () => {
  const owner = { tenant: randomUUID(),subject: "alice" },catalog = supabaseUploadCatalog(url,secret);
  const intake = new UploadIntake(catalog,raw,{ maxBytes: 3,maxFiles: 1 });
  let accepted: Awaited<ReturnType<UploadIntake["accept"]>> | undefined;
  try {
    const attempts = await Promise.allSettled([intake.accept(owner,"one.txt","text/plain",new TextEncoder().encode("one")),
      intake.accept(owner,"two.txt","text/plain",new TextEncoder().encode("two"))]);
    expect(attempts.filter(attempt => attempt.status === "fulfilled")).toHaveLength(1);
    accepted = attempts.find(attempt => attempt.status === "fulfilled")?.value;
    expect(accepted?.state).toBe("quarantined");
    expect(await intake.usage(owner)).toEqual({ files: 1,bytes: 3 });
    expect(["one","two"]).toContain(new TextDecoder().decode((await raw.get(owner,accepted!.id))!));
  } finally {
    if (accepted) await intake.remove(owner,accepted.id);
    await catalog.close();
  }
  expect(await intake.usage(owner)).toEqual({ files: 0,bytes: 0 });
});

it("serves authenticated HTTP quarantine metadata while keeping real Storage bytes private",async () => {
  const token = `live-upload-${randomUUID()}-${randomUUID()}`,tenant = randomUUID();
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("APP_API_KEYS",JSON.stringify([{ sha256: createHash("sha256").update(token).digest("hex"),
    tenant,subject: "http-owner",scopes: ["uploads:read","uploads:write"] }]));
  const catalog = supabaseUploadCatalog(url,secret),api = uploadHandlers(async () => catalog,async () => raw);
  const endpoint = "http://localhost:3000/api/v1/uploads";
  const request = (method: string,path = endpoint,body?: Uint8Array) => new Request(path,{ method,body: body ? Buffer.from(body) : undefined,
    headers: { authorization: `Bearer ${token}`,...(body ? {
      "content-type": "application/octet-stream","x-upload-name": "live.txt","x-upload-media-type": "text/plain",
    } : {}) } });
  let id: string | undefined;
  try {
    const created = await api.create(request("POST",endpoint,new TextEncoder().encode("private live bytes")));
    expect(created.status).toBe(201);
    id = (await created.json()).id;
    const list = await (await api.list(request("GET"))).json();
    expect(list).toMatchObject({ items: [{ id,state: "quarantined" }],usage: { files: 1,bytes: 18 } });
    expect(JSON.stringify(list)).not.toContain("private live bytes");
    expect(new TextDecoder().decode((await raw.get({ tenant,subject: "http-owner" },id!))!))
      .toBe("private live bytes");
    expect((await api.delete(request("DELETE",`${endpoint}/${id}`),id!)).status).toBe(204);
    id = undefined;
  } finally {
    if (id) await api.delete(request("DELETE",`${endpoint}/${id}`),id);
    await catalog.close();
  }
});
