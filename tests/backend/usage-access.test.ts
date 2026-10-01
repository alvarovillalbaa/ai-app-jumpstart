import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { createHash,randomUUID } from "node:crypto";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { UsageService } from "../../lib/budgets/usage";
import { usageHandlers } from "../../lib/http/usage";
import { run } from "../../scripts/app-cli";

const alice = "alice-account-token-".repeat(4),bob = "bob-account-token-".repeat(4),key = "record-key-".repeat(5);
const owner = { tenant: "supabase:https://identity.example",subject: "alice" };
let store: ReturnType<typeof sqliteBudgetStore>,api: ReturnType<typeof usageHandlers>;
let operation: string,correction: string;
beforeEach(async () => {
  for (const [name,value] of Object.entries({ AUTH_PROVIDER: "supabase",SUPABASE_AUTH_URL: "https://identity.example",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",AI_CHAT_ENABLED: "false",AI_BUDGET_POLICY_JSON: "invalid inactive policy",
    AI_CREATION_SIGNING_JSON: "",AI_RUNTIME_ORIGIN: "",APP_ORIGIN: "http://localhost:3000",APP_REQUESTS_PER_MINUTE: "0",
    APP_API_KEYS: JSON.stringify([{ ...owner,sha256: createHash("sha256").update(key).digest("hex"),scopes: ["records:read"] }]) })) vi.stubEnv(name,value);
  vi.stubGlobal("fetch",vi.fn(async (url: unknown,init?: RequestInit) => {
    expect(String(url)).toBe("https://identity.example/auth/v1/user");
    const token = new Headers(init?.headers).get("authorization");
    const subject = token === `Bearer ${alice}` ? "alice" : token === `Bearer ${bob}` ? "bob" : null;
    return subject ? Response.json({ id: subject,role: "authenticated",is_anonymous: false,
      user_metadata: { subject: "alice",tenant: owner.tenant } }) : Response.json({ msg: "Revoked",code: "session_not_found" },{ status: 401 });
  }));
  store = sqliteBudgetStore(":memory:");api = usageHandlers(async () => store);
  operation = randomUUID();correction = randomUUID();
  const policy = { id: "retained-fixture",dailyMicros: 100,maxActive: 10,maxPerMinute: 20 };
  const reserve = async (subject: string,tenant = owner.tenant) => {
    const operationId = subject === "alice" && tenant === owner.tenant ? operation : randomUUID();
    expect(await store.reserve({ tenant,subject,operationId,requestHash: "a".repeat(64),estimateMicros: 20,policy,now: Date.now() })).toMatchObject({ status: "reserved" });
    return operationId;
  };
  await reserve("alice");await store.settle({ ...owner,operationId: operation,actualMicros: null });
  expect(await store.correctSettlement({ ...owner,operationId: operation,correctionId: correction,expectedActualMicros: null,
    correctedActualMicros: 5,actor: "private-operator",reason: "Private reconciliation evidence",evidenceRef: "private-receipt" })).toBe("applied");
  await reserve("bob");await reserve("alice","supabase:https://other-tenant.example");
});
afterEach(async () => { await store.close();vi.unstubAllGlobals();vi.unstubAllEnvs(); });
const request: typeof fetch = async (url,init) => {
  const req = new Request(url,init),path = new URL(req.url).pathname;
  return path.endsWith("/reservations") ? api.reservations(req) : path.endsWith("/corrections") ? api.corrections(req) : api.current(req);
};
function req(path = "",token = alice) { return new Request(`http://localhost:3000/api/v1/usage${path}`,{ headers: { authorization: `Bearer ${token}` } }); }

it("shares paused usage and redacted ledgers across REST and CLI without runtime configuration",async () => {
  const response = await api.current(req());expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("no-store");
  const snapshot = await response.json();expect(snapshot).toMatchObject({ dailyLimitMicros: null,chargedMicros: 5,reservedMicros: 0,active: 0,unknownCosts: 0 });
  expect(await run(["usage"],{ APP_API_TOKEN: alice },request)).toEqual(snapshot);
  const reservations = await run(["usage","reservations"],{ APP_API_TOKEN: alice },request);
  expect(reservations).toMatchObject({ items: [{ operationId: operation,status: "settled",actualMicros: 5 }],nextCursor: null });
  const corrections = await run(["usage","corrections"],{ APP_API_TOKEN: alice },request);
  expect(corrections).toEqual({ items: [{ correctionId: correction,operationId: operation,previousActualMicros: null,correctedActualMicros: 5,at: expect.any(Number) }],nextCursor: null });
  for (const result of [reservations,corrections]) {
    expect(JSON.stringify(result)).not.toMatch(/private-operator|private-receipt|Private reconciliation|requestHash|tenant|subject/);
  }
});

it("fences tenants and subjects using verified identity rather than user metadata",async () => {
  expect(await (await api.current(req("",bob))).json()).toMatchObject({ dailyLimitMicros: null,chargedMicros: 0,reservedMicros: 20,active: 1 });
  const rows = await (await api.reservations(req("/reservations",bob))).json();
  expect(rows.items).toHaveLength(1);expect(rows.items[0].operationId).not.toBe(operation);
  expect(await (await api.corrections(req("/corrections",bob))).json()).toEqual({ items: [],nextCursor: null });
});

it("denies matching-owner record keys, missing sessions and revoked credentials on every read",async () => {
  for (const token of [key,"revoked-account-token"]) {
    for (const handler of [api.current,api.reservations,api.corrections]) expect((await handler(req("",token))).status).toBe(401);
  }
  expect((await api.current(new Request("http://localhost:3000/api/v1/usage"))).status).toBe(401);
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({ msg: "Revoked",code: "session_not_found" },{ status: 401 })));
  expect((await api.current(req())).status).toBe(401);
});

it("keeps historical reads available when an enabled runtime policy is invalid but reports current policy failure",async () => {
  vi.stubEnv("AI_CHAT_ENABLED","true");
  expect((await api.current(req())).status).toBe(503);
  expect((await api.reservations(req())).status).toBe(200);expect((await api.corrections(req())).status).toBe(200);
});

it("validates pagination and refuses owner injection in ledger queries",async () => {
  for (const query of ["limit=0","limit=101","cursor=invalid","subject=alice","tenant=forged"]) {
    expect((await api.reservations(req(`?${query}`))).status).toBe(400);
    expect((await api.corrections(req(`?${query}`))).status).toBe(400);
  }
  expect((await api.reservations(req("?limit=1"))).status).toBe(200);
});

it("reports store failures without returning empty retained data",async () => {
  const failed = usageHandlers(async () => { throw new Error("Private database unavailable"); });
  for (const handler of [failed.current,failed.reservations,failed.corrections]) {
    const response = await handler(req());expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: "internal_error" } });
  }
});

it("accepts a disabled limit but rejects zero, missing, fractional and out-of-range allowances",() => {
  expect(() => new UsageService(store,owner,null)).not.toThrow();
  expect(() => new UsageService(store,owner,100)).not.toThrow();
  for (const limit of [0,-1,0.5,1_000_000_000_001,undefined]) expect(() => new UsageService(store,owner,limit as number)).toThrow();
});
