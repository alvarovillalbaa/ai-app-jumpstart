import { convexTest } from "convex-test";
import { afterEach,expect,it,vi } from "vitest";
import schema from "../../convex/schema";
import { accountAuditEntities } from "../../convex/audit";
import { accountDataInventory } from "../../scripts/account-data-inventory.mjs";
import { inspectConvexAccountData } from "../../scripts/inspect-convex-account-data";

const modules = import.meta.glob("../../convex/**/*.ts");
const auditSecret = "test-convex-account-audit-secret-".repeat(2);
afterEach(() => vi.unstubAllEnvs());

it("keeps the read-only Convex audit allowlist aligned with every classified owner table",() => {
  expect([...accountAuditEntities].sort()).toEqual(accountDataInventory.filter(entry => entry.convex && entry.owner !== "global-expiring" && entry.owner !== "closure-control")
    .map(entry => entry.convex).sort());
});

it("inspects all Convex tables in bounded pages, including child orphans, without returning identities",async () => {
  vi.stubEnv("CONVEX_AUDIT_SECRET",auditSecret);
  const backend = convexTest(schema,modules),alice = { tenant: "private-tenant",subject: "alice-private" };
  const bob = { tenant: "private-tenant",subject: "bob-private" },operationId = crypto.randomUUID();
  await backend.run(async ctx => {
    for (let index = 0;index < 105;index++) await ctx.db.insert("records",{ ...alice,id: crypto.randomUUID(),title: `A${index}`,content: "private",revision: 1,createdAt: "now",updatedAt: "now" });
    await ctx.db.insert("records",{ ...bob,id: crypto.randomUUID(),title: "B",content: "private",revision: 1,createdAt: "now",updatedAt: "now" });
    await ctx.db.insert("conversations",{ ...alice,id: crypto.randomUUID(),operationId,requestHash: "a".repeat(64),sessionId: "session",status: "active" });
    await ctx.db.insert("conversationEvents",{ operationId,eventId: "e1",ordinal: 1,payload: "private" });
    await ctx.db.insert("conversationEvents",{ operationId: "orphan",eventId: "e2",ordinal: 1,payload: "orphan" });
    const mismatchedArtifact = crypto.randomUUID();
    await ctx.db.insert("artifacts",{ ...bob,id: mismatchedArtifact,operationId,sessionId: "session",callId: "call",
      inputHash: "a".repeat(64),title: "mismatch",content: "private",createdAt: 1 });
    await ctx.db.insert("artifactVersions",{ artifactId: mismatchedArtifact,revision: 1,title: "mismatch",content: "private",updatedAt: 1 });
    await ctx.db.insert("uploads",{ ...alice,id: crypto.randomUUID(),name: "private",mediaType: "text/plain",size: 1,
      sha256: "a".repeat(64),createdAt: 1,state: "deleted" });
  });
  const request: typeof fetch = (url,init) => backend.fetch(new URL(url instanceof Request ? url.url : url).pathname,init);
  const result = await inspectConvexAccountData("https://test.convex.site",auditSecret,alice.tenant,alice.subject,request);
  expect(result).toMatchObject({ provider: "convex",ownerRows: { records: 105,conversations: 1,conversationEvents: 1,uploads: 1 },
    orphanRows: { conversationEvents: 1,artifacts: 1,artifactVersions: 1 },ownerRowTotal: 108,orphanRowTotal: 3,
    applicationWriteFenced: false });
  expect(JSON.stringify(result)).not.toContain(alice.tenant);
  expect(JSON.stringify(result)).not.toContain(alice.subject);
  await backend.run(async ctx => { await ctx.db.insert("accountFences",{ ...alice,createdAt: Date.now() }); });
  expect(await inspectConvexAccountData("https://test.convex.site",auditSecret,alice.tenant,alice.subject,request))
    .toMatchObject({ applicationWriteFenced: true });
  const foreign = await inspectConvexAccountData("https://test.convex.site",auditSecret,bob.tenant,bob.subject,request);
  expect(foreign).toMatchObject({ ownerRowTotal: 1,applicationWriteFenced: false,ownerRows: { records: 1,conversations: 0,uploads: 0 } });
});

it("keeps the audit endpoint separate from the application backend credential",async () => {
  vi.stubEnv("CONVEX_AUDIT_SECRET",auditSecret);
  vi.stubEnv("CONVEX_BACKEND_SECRET","test-convex-application-secret-".repeat(2));
  const backend = convexTest(schema,modules);
  const body = JSON.stringify({ operation: "accountPage",entity: "records",tenant: "owner",subject: "subject",cursor: null });
  const call = (header: Record<string,string>,payload = body) => backend.fetch("/app/audit",{
    method: "POST",headers: { "content-type": "application/json",...header },body: payload });
  expect((await call({})).status).toBe(401);
  expect((await call({ "x-jumpstart-backend-key": "test-convex-application-secret-".repeat(2) })).status).toBe(401);
  expect((await call({ "x-jumpstart-backend-key": "test-convex-application-secret-".repeat(2) },JSON.stringify({
    operation: "accountFenceStatus",tenant: "owner",subject: "subject" }))).status).toBe(401);
  expect((await call({ "x-jumpstart-audit-key": auditSecret },JSON.stringify({ ...JSON.parse(body),entity: "internalNonces" }))).status).toBe(400);
  expect((await call({ "x-jumpstart-audit-key": auditSecret },"x".repeat(4097))).status).toBe(413);
  expect((await call({ "x-jumpstart-audit-key": auditSecret })).status).toBe(200);
});

it("fails the operator inspection without publishing partial counts on a malformed page",async () => {
  const malformed: typeof fetch = async () => Response.json({ owned: 1,orphans: 0,scanned: 1,done: false,cursor: null });
  await expect(inspectConvexAccountData("https://test.convex.site",auditSecret,"tenant","subject",malformed))
    .rejects.toThrow("invalid page");
});
