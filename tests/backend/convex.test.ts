import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import { ConvexRepository } from "../../lib/data/convex";
import { recordContract } from "../contracts/records";
import { convexAccessStore } from "../../lib/agent-access/convex";
import { sessionAccessContract } from "../contracts/session-access";

const modules = import.meta.glob("../../convex/**/*.ts");
const secret = "isolated-convex-test-secret-".repeat(2);
beforeEach(() => vi.stubEnv("CONVEX_BACKEND_SECRET", secret));
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const backend = convexTest(schema, modules);
  const request: typeof fetch = (url, init) => backend.fetch(new URL(url instanceof Request ? url.url : url).pathname, init);
  return { backend, repository: new ConvexRepository("https://test.convex.site", secret, request), access: convexAccessStore("https://test.convex.site",secret,request) };
}
recordContract("Convex HTTP + function emulator", async () => fixture().repository);
sessionAccessContract("Convex HTTP + function emulator",async () => fixture().access);

it("backfills legacy Convex history idempotently and retains its original timestamp and binding",async () => {
  const { backend,access } = fixture(), owner = { tenant: "org",subject: "alice" };
  const id = crypto.randomUUID(), operationId = crypto.randomUUID();
  const createdAt = await backend.run(async ctx => {
    const row = await ctx.db.insert("conversations",{ ...owner,id,operationId,requestHash: "a".repeat(64),sessionId: "legacy",status: "active" });
    return Math.floor((await ctx.db.get(row))!._creationTime);
  });
  await expect(access.list(owner,{})).rejects.toBeDefined();
  expect(await backend.mutation(internal.access.backfillMetadata,{})).toEqual({ updated: 1,remaining: false });
  expect(await backend.mutation(internal.access.backfillMetadata,{})).toEqual({ updated: 0,remaining: false });
  expect((await access.list(owner,{})).items).toEqual([{ id,operationId,createdAt,title: "New conversation",archived: false,revision: 1,status: "active" }]);
  expect(await access.ownsSession(owner,"legacy")).toBe(true);
});

it("stores the expected schema through an internal mutation", async () => {
  const { backend } = fixture();
  const row = await backend.mutation(internal.records.create, { id: crypto.randomUUID(), tenant: "test", subject: "test", title: "test", content: "" });
  expect(row.revision).toBe(1);
});

it("rejects unauthenticated backend requests and malformed/oversized commands", async () => {
  const { backend } = fixture();
  const call = (body: string, key?: string) => backend.fetch("/app/records", {
    method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-jumpstart-backend-key": key } : {}) }, body,
  });
  expect((await call('{"operation":"health"}')).status).toBe(401);
  expect((await call('{"operation":"health"}', "wrong-secret-".repeat(4))).status).toBe(401);
  expect((await call('{"operation":"list","tenant":"x","subject":"y","limit":101}', secret)).status).toBe(400);
  expect((await call("x".repeat(131073), secret)).status).toBe(413);
  vi.stubEnv("CONVEX_BACKEND_SECRET", "");
  expect((await call('{"operation":"health"}', secret)).status).toBe(401);
});

it("rejects unsafe endpoints and malformed provider output without leaking it", async () => {
  expect(() => new ConvexRepository("http://remote.example", secret)).toThrow("HTTPS");
  expect(() => new ConvexRepository("https://user:password@remote.example", secret)).toThrow("origin");
  const repository = new ConvexRepository("https://test.convex.site", secret, async () => Response.json({ secret: "do not expose", ready: true }));
  await expect(repository.health()).rejects.toMatchObject({ code: "storage_contract_error" });
});
