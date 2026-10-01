import { convexTest } from "convex-test";
import { readFileSync,readdirSync } from "node:fs";
import { afterEach,expect,it,vi } from "vitest";
import { internal } from "../../convex/_generated/api";
import schema from "../../convex/schema";
import { setConvexAccountFence } from "../../scripts/fence-account-writes";

const modules = import.meta.glob("../../convex/**/*.ts");
const auditSecret = "test-convex-write-fence-secret-".repeat(2);
afterEach(() => vi.unstubAllEnvs());

it("requires an in-transaction guard on every owner-writing Convex mutation",() => {
  const exceptions = new Set(["audit:setAccountFence","audit:eraseAccountRows","access:claimNonce","records:remove"]),seen = new Set<string>();
  for (const file of readdirSync("convex").filter(name => name.endsWith(".ts"))) {
    const source = readFileSync(`convex/${file}`,"utf8"),matches = [...source.matchAll(/export const (\w+)\s*=\s*internalMutation\(\{/gu)];
    expect(matches.length,`${file} has an unclassified mutation declaration`).toBe([...source.matchAll(/\binternalMutation\(\{/gu)].length);
    for (const match of matches) {
      const key = `${file.slice(0,-3)}:${match[1]}`;
      if (exceptions.has(key)) { seen.add(key);continue; }
      const nextExport = source.indexOf("export const ",match.index!+match[0].length);
      const body = source.slice(match.index,nextExport < 0 ? source.length : nextExport);
      expect(body.includes("assertAccountOpen(ctx"),`${key} needs the atomic owner fence guard`).toBe(true);
    }
  }
  expect(seen).toEqual(exceptions);
});

it("uses only the operator credential to install an atomic Convex row fence",async () => {
  vi.stubEnv("CONVEX_AUDIT_SECRET",auditSecret);
  vi.stubEnv("CONVEX_BACKEND_SECRET","test-convex-application-secret-".repeat(2));
  const backend = convexTest(schema,modules),alice = { tenant: "private-tenant",subject: "private-alice" },
    bob = { ...alice,subject: "private-bob" },id = crypto.randomUUID();
  const request: typeof fetch = (url,init) => backend.fetch(new URL(url instanceof Request ? url.url : url).pathname,init);
  await backend.mutation(internal.records.create,{ ...alice,id,title: "Original",content: "private" });
  const unauthorized = await backend.fetch("/app/audit",{ method: "POST",headers: {
    "content-type": "application/json","x-jumpstart-backend-key": "test-convex-application-secret-".repeat(2),
  },body: JSON.stringify({ operation: "setAccountFence",...alice }) });
  expect(unauthorized.status).toBe(401);
  expect(await setConvexAccountFence("https://example.convex.site",auditSecret,alice,request))
    .toMatchObject({ status: "fenced",created: true });
  const repeated = await setConvexAccountFence("https://example.convex.site",auditSecret,alice,request);
  expect(repeated).toMatchObject({ status: "fenced",created: false });
  expect(JSON.stringify(repeated)).not.toContain(alice.tenant);
  expect(JSON.stringify(repeated)).not.toContain(alice.subject);
  expect(await backend.query(internal.records.get,{ ...alice,id })).toMatchObject({ title: "Original" });
  await expect(backend.mutation(internal.records.create,{ ...alice,id: crypto.randomUUID(),title: "Late",content: "private" }))
    .rejects.toThrow("fenced");
  await expect(backend.mutation(internal.records.update,{ ...alice,id,title: "Late",content: "private",revision: 1 }))
    .rejects.toThrow("fenced");
  await expect(backend.mutation(internal.access.reserve,{ ...alice,id: crypto.randomUUID(),operationId: crypto.randomUUID(),
    requestHash: "a".repeat(64),title: "Late" })).rejects.toThrow("fenced");
  await expect(backend.mutation(internal.uploads.reserve,{ ...alice,input: {},quota: {} })).rejects.toThrow("fenced");
  await expect(backend.mutation(internal.preferences.update,{ ...alice,patch: {} })).rejects.toThrow("fenced");
  await expect(backend.mutation(internal.requestLimits.claim,{ ...alice,limit: 100 })).rejects.toThrow("fenced");
  await backend.mutation(internal.records.create,{ ...bob,id: crypto.randomUUID(),title: "Bob",content: "private" });
  expect(await backend.mutation(internal.records.remove,{ ...alice,id,revision: 1 })).toBe(true);
});
