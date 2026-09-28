import { mkdirSync,mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { afterEach,expect,it,vi } from "vitest";
import type { Id } from "../../convex/_generated/dataModel";
import schema from "../../convex/schema";
import { eraseAccountRows } from "../../scripts/erase-account-rows";
import { exportAccountBundle,verifyAccountBundle } from "../../scripts/export-account-bundle";
import { setConvexAccountFence } from "../../scripts/fence-account-writes";
import { convexAccessStore } from "../../lib/agent-access/convex";

const modules = import.meta.glob("../../convex/**/*.ts");
const auditSecret = "test-convex-audit-secret-".repeat(2);
const erasureSecret = "test-convex-erasure-secret-".repeat(2);
const owner = { tenant: "erasure-tenant",subject: "erasure-owner" };
const foreign = { ...owner,subject: "foreign-owner" };
afterEach(() => vi.unstubAllEnvs());

it("preflights exact Convex rows, denies foreign IDs, and resumes bounded deletion after interruption",async () => {
  vi.stubEnv("CONVEX_AUDIT_SECRET",auditSecret);
  vi.stubEnv("CONVEX_ERASURE_SECRET",erasureSecret);
  vi.stubEnv("CONVEX_BACKEND_SECRET","test-convex-application-secret-".repeat(2));
  const backend = convexTest(schema,modules);
  const request: typeof fetch = (url,init) => backend.fetch(new URL(url instanceof Request ? url.url : url).pathname,init);
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-convex-erasure-"));
  const root = join(dir,"objects"),bundle = join(dir,"bundle"),site = "https://test.convex.site";
  const operationId = crypto.randomUUID();
  let firstId = "",foreignId = "";
  try {
    mkdirSync(root,{ mode: 0o700 });
    await backend.run(async ctx => {
      for (let index = 0;index < 23;index++) {
        const id = await ctx.db.insert("records",{ ...owner,id: crypto.randomUUID(),title: `Alice ${index}`,
          content: "private",revision: 1,createdAt: "now",updatedAt: "now" });
        if (index === 0) firstId = id;
      }
      foreignId = await ctx.db.insert("records",{ ...foreign,id: crypto.randomUUID(),title: "Bob",
        content: "foreign",revision: 1,createdAt: "now",updatedAt: "now" });
      await ctx.db.insert("conversations",{ ...owner,id: crypto.randomUUID(),operationId,
        requestHash: "a".repeat(64),sessionId: "session",status: "active" });
      await ctx.db.insert("conversationEvents",{ operationId,eventId: "e1",ordinal: 1,payload: "private event" });
    });
    await setConvexAccountFence(site,auditSecret,owner,request);
    const access = convexAccessStore(site,process.env.CONVEX_BACKEND_SECRET!,request);
    expect(await access.isFenced(owner)).toBe(true);
    expect(await access.isFenced(foreign)).toBe(false);
    const env = { CONVEX_SITE_URL: site,CONVEX_AUDIT_SECRET: auditSecret,
      CONVEX_ERASURE_SECRET: erasureSecret,UPLOAD_LOCAL_ROOT: root };
    await exportAccountBundle("convex","local",owner,bundle,env,request);
    await expect(eraseAccountRows("convex",owner,bundle,{ ...env,CONVEX_ERASURE_SECRET: undefined },false,request))
      .resolves.toMatchObject({ rows: 25,remainingBefore: 25,deleted: 0,status: "application-row-erasure-planned" });
    const audit = (payload: unknown,headers: Record<string,string>) => backend.fetch("/app/audit",{
      method: "POST",headers: { "content-type": "application/json","x-jumpstart-audit-key": auditSecret,...headers },
      body: JSON.stringify(payload) });
    const foreignDelete = { operation: "eraseAccountRows",entity: "records",...owner,ids: [firstId,foreignId] };
    expect((await audit(foreignDelete,{})).status).toBe(401);
    expect((await audit(foreignDelete,{ "x-jumpstart-erasure-key": erasureSecret })).status).toBe(500);
    expect((await audit({ ...foreignDelete,...foreign,ids: [foreignId] },
      { "x-jumpstart-erasure-key": erasureSecret })).status).toBe(500);
    expect(await backend.run(async ctx => ctx.db.get("records",foreignId as Id<"records">))).toMatchObject({ content: "foreign" });
    expect(await backend.run(async ctx => ctx.db.get("records",firstId as Id<"records">))).toMatchObject({ content: "private" });
    vi.stubEnv("CONVEX_ERASURE_SECRET",auditSecret);
    expect((await audit({ ...foreignDelete,ids: [firstId] },{ "x-jumpstart-erasure-key": auditSecret })).status).toBe(503);
    vi.stubEnv("CONVEX_ERASURE_SECRET",erasureSecret);
    await backend.run(async ctx => { await ctx.db.patch("records",firstId as Id<"records">,{ content: "changed" }); });
    await expect(eraseAccountRows("convex",owner,bundle,env,false,request)).rejects.toThrow("differ");
    await backend.run(async ctx => { await ctx.db.patch("records",firstId as Id<"records">,{ content: "private" }); });
    let eraseCalls = 0;
    const interrupted: typeof fetch = (url,init) => {
      const payload = JSON.parse(String(init?.body));
      if (payload.operation === "eraseAccountRows" && ++eraseCalls === 2)
        return Promise.resolve(Response.json({ error: "temporary" },{ status: 503 }));
      return request(url,init);
    };
    await expect(eraseAccountRows("convex",owner,bundle,env,true,interrupted))
      .rejects.toThrow("request failed");
    expect(eraseCalls).toBe(2);
    expect(await verifyAccountBundle(bundle)).toMatchObject({ rows: 25 });
    const result = await eraseAccountRows("convex",owner,bundle,env,true,request);
    expect(result).toMatchObject({ rows: 25,status: "application-rows-erased" });
    expect(result.remainingBefore).toBeLessThan(25);
    expect(result.deleted).toBe(result.remainingBefore);
    const final = await backend.run(async ctx => ({
      records: await ctx.db.query("records").collect(),
      conversations: await ctx.db.query("conversations").collect(),
      events: await ctx.db.query("conversationEvents").collect(),
      fence: await ctx.db.query("accountFences").withIndex("by_owner",q =>
        q.eq("tenant",owner.tenant).eq("subject",owner.subject)).unique(),
    }));
    expect(final.records).toHaveLength(1);
    expect(final.records[0].subject).toBe(foreign.subject);
    expect(final.conversations).toHaveLength(0);
    expect(final.events).toHaveLength(0);
    expect(final.fence).toBeTruthy();
    await expect(eraseAccountRows("convex",owner,bundle,env,true,request)).resolves.toMatchObject({
      rows: 25,remainingBefore: 0,deleted: 0,status: "application-rows-erased" });
  } finally { rmSync(dir,{ recursive: true,force: true }); }
},30_000);
