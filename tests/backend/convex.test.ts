import { createHash } from "node:crypto";
import { preferenceContract } from "../contracts/preferences";
import { requestLimitContract } from "../contracts/request-limits";
import { convexRequestLimitStore } from "../../lib/request-limits/remote";
import { convexPreferenceStore } from "../../lib/preferences/convex";
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
  return { backend,limits: convexRequestLimitStore("https://test.convex.site",secret,request),preferences: convexPreferenceStore("https://test.convex.site",secret,request), repository: new ConvexRepository("https://test.convex.site", secret, request), access: convexAccessStore("https://test.convex.site",secret,request) };
}
requestLimitContract("Convex HTTP + function emulator",async () => fixture().limits);
preferenceContract("Convex HTTP + function emulator",async () => fixture().preferences);
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

it("backfills legacy run facts in bounded pages without marking skipped ranges verified",async () => {
  const { backend,access } = fixture(),owner = { tenant: "org",subject: "alice" },operationId = crypto.randomUUID();
  const entries = ["running","completed"].map((state,index) => ({ schemaVersion: 1,eventId: `evt_${String(index+1).padStart(26,"0")}`,
    turnId: "legacy-turn",sequence: index,at: "2026-09-27T10:00:00.000Z",payload: { kind: "run",state } }));
  await backend.run(async ctx => {
    await ctx.db.insert("conversations",{ ...owner,id: crypto.randomUUID(),operationId,requestHash: "a".repeat(64),sessionId: "legacy",status: "active",
      projectionSequence: 2,projectionCheckpoint: 2 });
    for (const [index,entry] of entries.entries()) await ctx.db.insert("conversationEvents",{ operationId,eventId: entry.eventId,payload: JSON.stringify(entry),ordinal: index+1,sourceIndex: index });
  });
  expect((await access.listRuns(owner,operationId,{})).items).toEqual([]);
  expect(await access.rebuildRuns(owner,operationId,{ after: 1,limit: 1 })).toEqual({ processed: 1,nextIndex: 2,complete: false });
  expect((await access.listRuns(owner,operationId,{})).items[0]).toMatchObject({ state: "unverified",coverage: { indexComplete: false } });
  expect(await access.rebuildRuns(owner,operationId,{ limit: 1 })).toEqual({ processed: 1,nextIndex: 1,complete: false });
  expect(await access.rebuildRuns(owner,operationId,{ after: 1,limit: 1 })).toEqual({ processed: 1,nextIndex: 2,complete: true });
  const page = await access.listRuns(owner,operationId,{});
  expect(page.items[0]).toMatchObject({ state: "completed",boundaryCount: 2,models: [],coverage: { indexComplete: true } });
  expect(await access.rebuildRuns(owner,operationId,{})).toEqual({ processed: 2,nextIndex: 2,complete: true });
  expect(await access.listRuns(owner,operationId,{})).toEqual(page);
  expect((await access.listRuns({ ...owner,subject: "bob" },operationId,{})).items).toEqual([]);
});

it("preserves legacy Convex approval replay through edits and atomically erases all history",async () => {
  const { backend,access } = fixture(),owner = { tenant: "org",subject: "alice" },id = crypto.randomUUID(),operationId = crypto.randomUUID(),deleted = crypto.randomUUID();
  const draft = { title: "Legacy original",content: "Approved legacy content" },session = "legacy-artifact-session";
  await backend.run(async ctx => {
    await ctx.db.insert("conversations",{ ...owner,id: crypto.randomUUID(),operationId,requestHash: "a".repeat(64),sessionId: session,status: "active" });
    const legacy = { ...owner,operationId,sessionId: session,callId: "legacy-call",inputHash: createHash("sha256").update(JSON.stringify(draft)).digest("hex"),...draft,createdAt: 10 };
    await ctx.db.insert("artifacts",{ ...legacy,id });
    await ctx.db.insert("artifacts",{ ...legacy,id: deleted,callId: "deleted-call",title: "Deleted artifact",content: " ",inputHash: "0".repeat(64),deletedAt: 11 });
  });
  const original = await access.getArtifact(owner,id);
  expect(original).toMatchObject({ revision: 1,updatedAt: 10 });
  expect(await access.listArtifactVersions(owner,id,{})).toEqual({ items: [original],nextBefore: null });
  expect(await access.listArtifactVersions(owner,deleted,{})).toBeNull();
  expect((await access.updateArtifact(owner,id,{ revision: 1,title: "Owner edit",content: "Second version" })).status).toBe("updated");
  expect(await access.saveArtifact(owner,operationId,session,"legacy-call",draft)).toEqual({ status: "existing",artifact: original });
  expect((await access.listArtifactVersions(owner,id,{}))!.items.map(item => item.content)).toEqual(["Second version",draft.content]);
  expect(await access.deleteArtifact(owner,id)).toBe(true);
  expect(await backend.run(ctx => ctx.db.query("artifactVersions").collect())).toEqual([]);
  expect(await access.saveArtifact(owner,operationId,session,"legacy-call",draft)).toEqual({ status: "unavailable" });
});
