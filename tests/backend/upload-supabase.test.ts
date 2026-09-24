import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { uploadObjectKey } from "../../lib/uploads/contract";
import { provisionPrivateUploadBucket, SUPABASE_UPLOAD_BUCKET, supabaseUploadObjects, verifyPrivateUploadBucket } from "../../lib/uploads/supabase";
import { MAX_UPLOAD_BYTES } from "../../lib/uploads/validation";
import { uploadObjectContract } from "../contracts/uploads";

type Storage = Parameters<typeof supabaseUploadObjects>[0];
const missing = Object.assign(new Error("not found"), { status: 404 });

function fakeStorage(initial: "private" | "public" | "missing" = "private") {
  let bucket = initial;
  const objects = new Map<string, Uint8Array>();
  const calls: { kind: string; key?: string; bucket?: string; options?: unknown }[] = [];
  const storage = {
    async getBucket(id: string) {
      calls.push({ kind: "getBucket", bucket: id });
      return bucket === "missing" ? { data: null, error: missing } : {
        data: { id, public: bucket === "public", file_size_limit: MAX_UPLOAD_BYTES, allowed_mime_types: ["application/octet-stream"] }, error: null,
      };
    },
    async createBucket(id: string, options: unknown) {
      calls.push({ kind: "createBucket", bucket: id, options });
      if (bucket !== "missing") return { data: null, error: new Error("already exists") };
      bucket = "private";
      return { data: { name: id }, error: null };
    },
    from(id: string) {
      calls.push({ kind: "from", bucket: id });
      return {
        async upload(key: string, body: Buffer, options: unknown) {
          calls.push({ kind: "upload", key, options });
          if (objects.has(key)) return { data: null, error: new Error("duplicate") };
          objects.set(key, Uint8Array.from(body));
          return { data: { path: key }, error: null };
        },
        async download(key: string) {
          calls.push({ kind: "download", key });
          const bytes = objects.get(key);
          return bytes ? { data: new Blob([Uint8Array.from(bytes)]), error: null } : { data: null, error: missing };
        },
        async remove(keys: string[]) {
          const [key] = keys;
          calls.push({ kind: "remove", key });
          const existed = objects.delete(key);
          return { data: existed ? [{ name: key }] : [], error: null };
        },
      };
    },
  } as unknown as Storage;
  return { storage, calls, objects, setPublic: () => { bucket = "public"; } };
}

uploadObjectContract("Supabase Storage adapter", async () => ({ store: supabaseUploadObjects(fakeStorage().storage), close: async () => {} }));

it("uses only an opaque key and binary content in the configured private bucket", async () => {
  const { storage, calls, objects } = fakeStorage();
  const owner = { tenant: "tenant/private", subject: "alice@example.test" }, id = randomUUID();
  await supabaseUploadObjects(storage).put(owner, id, new TextEncoder().encode("private"));
  const key = uploadObjectKey(owner, id);
  expect([...objects.keys()]).toEqual([key]);
  expect(calls.filter(call => call.kind === "from")).toEqual([{ kind: "from", bucket: SUPABASE_UPLOAD_BUCKET }]);
  expect(calls.find(call => call.kind === "upload")).toEqual({ kind: "upload", key,
    options: { contentType: "application/octet-stream", cacheControl: "0", upsert: false } });
});

it("fails closed if a previously private bucket becomes public", async () => {
  const { storage, calls, setPublic } = fakeStorage();
  const store = supabaseUploadObjects(storage);
  const owner = { tenant: "tenant", subject: "alice" }, id = randomUUID();
  await store.put(owner, id, Uint8Array.of(1));
  setPublic();
  await expect(store.get(owner, id)).rejects.toThrow("private");
  await expect(store.delete(owner, id)).rejects.toThrow("private");
  await expect(store.put(owner, randomUUID(), Uint8Array.of(2))).rejects.toThrow("private");
  expect(calls.filter(call => ["download", "remove", "upload"].includes(call.kind))).toHaveLength(1);
});

it("provisions a missing bucket only on request and refuses a public one", async () => {
  const empty = fakeStorage("missing");
  await expect(verifyPrivateUploadBucket(empty.storage)).rejects.toBe(missing);
  expect(empty.calls.some(call => call.kind === "createBucket")).toBe(false);
  await provisionPrivateUploadBucket(empty.storage);
  expect(empty.calls.find(call => call.kind === "createBucket")).toEqual({ kind: "createBucket", bucket: SUPABASE_UPLOAD_BUCKET,
    options: { public: false, fileSizeLimit: MAX_UPLOAD_BYTES, allowedMimeTypes: ["application/octet-stream"] } });
  await expect(provisionPrivateUploadBucket(fakeStorage("public").storage)).rejects.toThrow("private");
});
