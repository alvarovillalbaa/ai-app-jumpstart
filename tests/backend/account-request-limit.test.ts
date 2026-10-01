import { createHash } from "node:crypto";
import { afterEach,expect,it,vi } from "vitest";
import { accountRequestLimitHandler } from "../../lib/http/account-request-limit";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { run } from "../../scripts/app-cli";

afterEach(() => { vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs(); });

it("reads only the verified owner's retained request window across REST and CLI",async () => {
  vi.spyOn(console,"info").mockImplementation(() => {});
  const alice = "alice-account-token-".repeat(4),bob = "bob-account-token-".repeat(4),key = "record-key-".repeat(5);
  const tenant = "supabase:https://identity.example";
  for (const [name,value] of Object.entries({ AUTH_PROVIDER: "supabase",SUPABASE_AUTH_URL: "https://identity.example",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",APP_ORIGIN: "http://localhost:3000",APP_REQUESTS_PER_MINUTE: "0",
    APP_API_KEYS: JSON.stringify([{ tenant,subject: "alice",sha256: createHash("sha256").update(key).digest("hex"),scopes: ["records:read"] }]) })) vi.stubEnv(name,value);
  vi.stubGlobal("fetch",vi.fn(async (_url: unknown,init?: RequestInit) => {
    const token = new Headers(init?.headers).get("authorization");
    const id = token === `Bearer ${alice}` ? "alice" : token === `Bearer ${bob}` ? "bob" : null;
    return id ? Response.json({ id,role: "authenticated",is_anonymous: false,user_metadata: { tenant: "forged",subject: "forged" } })
      : Response.json({ code: "session_not_found" },{ status: 401 });
  }));
  const store = sqliteRequestLimitStore(":memory:",() => 600000);
  const handler = accountRequestLimitHandler(async () => store);
  const request = (token: string) => new Request("http://localhost:3000/api/v1/account/request-limit",{ headers: { authorization: `Bearer ${token}` } });
  try {
    expect((await handler(request(alice))).status).toBe(200);
    expect(await (await handler(request(alice))).json()).toEqual({ snapshot: null });
    await store.claim({ tenant,subject: "alice" },5);
    await store.claim({ tenant,subject: "alice" },5);
    await store.claim({ tenant,subject: "bob" },5);
    const snapshot = { snapshot: { windowStartAt: "1970-01-01T00:10:00.000Z",admitted: 2 } };
    expect(await (await handler(request(alice))).json()).toEqual(snapshot);
    expect(await (await handler(new Request("http://localhost:3000/api/v1/account/request-limit?tenant=forged&subject=bob",{
      headers: { authorization: `Bearer ${alice}` },
    }))).json()).toEqual(snapshot);
    expect(await run(["account","request-limit"],{ APP_API_TOKEN: alice },async (url,init) => handler(new Request(url,init)))).toEqual(snapshot);
    expect(await (await handler(request(bob))).json()).toEqual({ snapshot: { windowStartAt: snapshot.snapshot.windowStartAt,admitted: 1 } });
    expect((await handler(request(key))).status).toBe(401);
    expect((await handler(request("revoked-token"))).status).toBe(401);
    const failed = accountRequestLimitHandler(async () => { throw new Error("private-db-credential"); });
    const response = await failed(request(alice));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private-db-credential");
  } finally { await store.close(); }
});
