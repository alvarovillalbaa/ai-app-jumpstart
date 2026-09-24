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
