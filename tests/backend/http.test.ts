import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { SqliteRepository } from "../../lib/data/sqlite";
import { recordHandlers } from "../../lib/http/records";
const token = "test-token-".repeat(5);
let repo: SqliteRepository;
beforeEach(() => {
  repo = new SqliteRepository(":memory:");
  vi.stubEnv("APP_API_KEYS", JSON.stringify([{ sha256: createHash("sha256").update(token).digest("hex"), tenant: "test", subject: "alice", scopes: ["records:read", "records:write"] }]));
});
afterEach(async () => { await repo.close(); vi.unstubAllEnvs(); });
function request(body: string, headers: Record<string, string> = {}) {
  return new Request("http://localhost:3000/api/v1/records", { method: "POST", body, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers } });
}
it("creates through the real HTTP boundary and reads the persisted record", async () => {
  const api = recordHandlers(async () => repo);
  const result = await api.create(request(JSON.stringify({ title: "Example", content: "Hello" })));
  expect(result.status).toBe(201); expect(result.headers.get("cache-control")).toBe("no-store");
  const created = await result.json();
  const fetched = await api.get(new Request("http://localhost:3000", { headers: { authorization: `Bearer ${token}` } }), created.id);
  expect(await fetched.json()).toEqual(created);
});
it("rejects missing credentials, hostile origin, bad JSON and oversized streaming bodies", async () => {
  const api = recordHandlers(async () => repo);
  expect((await api.create(request("{}", { authorization: "" }))).status).toBe(401);
  expect((await api.create(request("{}", { origin: "https://evil.example" }))).status).toBe(403);
  expect((await api.create(request("{broken"))).status).toBe(400);
  expect((await api.create(request("x".repeat(131073)))).status).toBe(413);
  expect((await api.create(request("{}", { "content-type": "text/plain" }))).status).toBe(415);
});
it("fails closed when auth is unconfigured and redacts unexpected provider errors", async () => {
  vi.stubEnv("APP_API_KEYS", "[]");
  expect((await recordHandlers(async () => repo).create(request("{}"))).status).toBe(503);
  vi.unstubAllEnvs();
  vi.stubEnv("APP_API_KEYS", JSON.stringify([{ sha256: createHash("sha256").update(token).digest("hex"), tenant: "test", subject: "alice", scopes: ["records:read"] }]));
  const result = await recordHandlers(async () => { throw new Error("postgres://secret@host"); }).list(request("{}"));
  expect(result.status).toBe(500); expect(await result.text()).not.toContain("secret");
});

it("reports keyed creation, replay, changed-input conflict, status and deletion without creating duplicates",async () => {
  const api = recordHandlers(async () => repo),key = crypto.randomUUID(),input = { title: "Keyed",content: "One record" };
  const create = (body = input,creationKey = key) => api.create(request(JSON.stringify(body),{ "idempotency-key": creationKey }));
  const first = await create(),row = await first.json();
  expect(first.status).toBe(201);expect(first.headers.get("idempotency-replayed")).toBe("false");
  const replay = await create(input,key.toUpperCase());
  expect(replay.status).toBe(200);expect(replay.headers.get("idempotency-replayed")).toBe("true");
  expect(replay.headers.get("location")).toBe(`/api/v1/records/${row.id}`);
  expect(await replay.json()).toEqual(row);
  expect((await create({ ...input,content: "Changed" })).status).toBe(409);
  expect((await create(input,"bad-key")).status).toBe(400);
  expect((await create(input,"")).status).toBe(400);
  const read = new Request("http://localhost:3000",{ headers: { authorization: `Bearer ${token}` } });
  expect(await (await api.creation(read,key)).json()).toEqual({ status: "created",record: row });
  await repo.delete({ tenant: "test",subject: "alice" },row.id,1);
  expect((await create()).status).toBe(410);
  expect(await (await api.creation(read,key)).json()).toEqual({ status: "deleted",id: row.id });
  expect((await api.creation(read,crypto.randomUUID())).status).toBe(404);
});
