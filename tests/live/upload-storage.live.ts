import { createHash,randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterEach,beforeAll, expect, it,vi } from "vitest";
import { uploadObjectKey, type PrivateUploadObjects } from "../../lib/uploads/contract";
import { SUPABASE_UPLOAD_BUCKET, supabaseUploadObjects, uploadStorageClient, verifyPrivateUploadBucket } from "../../lib/uploads/supabase";
import { verifyUploadStoragePolicy } from "../../lib/uploads/storage-policy";
import { supabaseUploadCatalog } from "../../lib/uploads/catalog-remote";
import { UploadIntake } from "../../lib/uploads/intake";
import { uploadObjectContract } from "../contracts/uploads";
import { uploadHandlers } from "../../lib/http/uploads";

const url = process.env.SUPABASE_URL,secret = process.env.SUPABASE_SECRET_KEY,anonKey = process.env.SUPABASE_ANON_KEY;
const database = process.env.DATABASE_URL;
if (!url || !secret || !anonKey || !database) throw new Error("Live Storage tests require local Supabase URL, backend secret, anon key and database URL.");
const storage = uploadStorageClient(url,secret).storage;
const raw = supabaseUploadObjects(storage);
beforeAll(async () => { await verifyUploadStoragePolicy(database);await verifyPrivateUploadBucket(storage); });
afterEach(() => vi.unstubAllEnvs());

uploadObjectContract("live Supabase Storage",async () => {
  const created: Array<{ owner: Parameters<PrivateUploadObjects["put"]>[0];id: string }> = [];
  const store: PrivateUploadObjects = {
    async put(owner,id,bytes) { await raw.put(owner,id,bytes);created.push({ owner,id }); },
    get: (owner,id) => raw.get(owner,id),delete: (owner,id) => raw.delete(owner,id),
  };
  return { store,close: async () => { for (const { owner,id } of created) await raw.delete(owner,id); } };
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
