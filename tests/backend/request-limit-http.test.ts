import { afterEach,expect,it,vi } from "vitest";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { recordHandlers } from "../../lib/http/records";
import { mcpHandler } from "../../lib/mcp";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import * as stores from "../../lib/request-limits/store";
import { admitDataRequest } from "../../lib/http/authenticated-data";
import { handle } from "../../lib/http/handler";
import { run } from "../../scripts/app-cli";

afterEach(() => { vi.restoreAllMocks();vi.unstubAllEnvs(); });
it("shares one owner quota across REST, CLI, MCP and rotated keys, with foreign-owner independence",async () => {
  vi.spyOn(console,"info").mockImplementation(() => {});
  const tokens = ["owner-one-".repeat(5),"owner-rotated-".repeat(5),"owner-two-".repeat(5)];
  vi.stubEnv("AUTH_PROVIDER","api-key");vi.stubEnv("APP_REQUESTS_PER_MINUTE","20");
  vi.stubEnv("APP_API_KEYS",JSON.stringify(tokens.map((token,index) => ({ sha256: createHash("sha256").update(token).digest("hex"),tenant: "org",subject: index<2 ? "alice" : "bob",scopes: ["records:read","records:write"] }))));
  const limits = sqliteRequestLimitStore(":memory:",() => 600000),repo = new SqliteRepository(":memory:");
  vi.spyOn(stores,"getRequestLimitStore").mockResolvedValue(limits);
  const claims = vi.spyOn(limits,"claim"),create = vi.spyOn(repo,"create"),list = vi.spyOn(repo,"list");
  const handlers = recordHandlers(async () => repo);
  const request = (token: string) => new Request("http://localhost:3000/api/v1/records",{ headers: { authorization: `Bearer ${token}` } });
  const rpc = mcpHandler(async () => repo);
  const client = new Client({ name: "quota-test",version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp"),{ requestInit: { headers: { authorization: `Bearer ${tokens[1]}` } },fetch: async (url,init) => {
    const req = new Request(url,init);return req.method === "POST" ? rpc(req) : new Response(null,{ status: 405 });
  } });
  try {
    expect((await handlers.list(request("bad-token".repeat(5)))).status).toBe(401);expect(claims).not.toHaveBeenCalled();
    expect((await handlers.list(request(tokens[0]))).status).toBe(200);
    await client.connect(transport);expect((await client.callTool({ name: "records_list",arguments: {} })).isError).not.toBe(true);
    while (claims.mock.calls.length<20) expect((await handlers.list(request(tokens[0]))).status).toBe(200);
    const denied = await handlers.list(request(tokens[1]));expect(denied.status).toBe(429);expect(denied.headers.get("retry-after")).toBe("60");
    const error = (await denied.json()).error;expect(error).toMatchObject({ code: "request_limit",requestId: denied.headers.get("x-request-id") });
    const listCount = list.mock.calls.length;
    await expect(run(["list"],{ APP_API_TOKEN: tokens[0] },async (url,init) => handlers.list(new Request(url,init)))).rejects.toThrow("HTTP 429: request_limit (reference:");
    await expect(client.callTool({ name: "records_create",arguments: { title: "Must not write",content: "private" } })).rejects.toBeDefined();
    expect(list).toHaveBeenCalledTimes(listCount);expect(create).not.toHaveBeenCalled();
    expect((await handlers.list(request(tokens[2]))).status).toBe(200);
  } finally { await client.close();await limits.close();await repo.close(); }
});
it("fails closed on provider errors or invalid responses without returning private diagnostics",async () => {
  vi.spyOn(console,"info").mockImplementation(() => {});
  const owner = { tenant: "org",subject: "alice" },env = { APP_REQUESTS_PER_MINUTE: "120" };
  const store = { claim: vi.fn(async () => { throw new Error("postgresql://private-secret@database"); }),snapshot: async () => null,health: async () => {},close: async () => {} };
  const accessStore = { isFenced: vi.fn(async () => false) },accessFactory = vi.fn(async () => accessStore);
  const response = await handle(new Request("http://localhost:3000/api/v1/records"),async () => {
    await admitDataRequest(owner,env,async () => store,accessFactory);return Response.json({ unexpected: true });
  });
  expect(response.status).toBe(503);expect(JSON.stringify(await response.json())).not.toContain("private-secret");
  await expect(admitDataRequest(owner,env,async () => ({ claim: async () => ({ allowed: false,remaining: 1,resetAt: new Date().toISOString(),retryAfterSeconds: 0 }),snapshot: async () => null,health: async () => {},close: async () => {} }),accessFactory)).rejects.toMatchObject({ code: "request_limit_unavailable" });
  const factory = vi.fn(async () => store);
  accessFactory.mockClear();
  await admitDataRequest(owner,{},factory,accessFactory);await admitDataRequest(owner,{ APP_REQUESTS_PER_MINUTE: "0" },factory,accessFactory);
  expect(factory).not.toHaveBeenCalled();
  expect(accessFactory).toHaveBeenCalledTimes(2);
});

it("denies permanently fenced owners before quotas or application handlers run",async () => {
  vi.spyOn(console,"info").mockImplementation(() => {});
  const owner = { tenant: "org",subject: "alice" },env = { APP_REQUESTS_PER_MINUTE: "120" };
  const claims = vi.fn(async () => ({ allowed: true,remaining: 119,resetAt: new Date().toISOString(),retryAfterSeconds: 0 }));
  const limits = { claim: claims,snapshot: async () => null,health: async () => {},close: async () => {} };
  const access = { isFenced: vi.fn(async () => true) };
  const response = await handle(new Request("http://localhost:3000/api/v1/records"),async () => {
    await admitDataRequest(owner,env,async () => limits,async () => access);return Response.json({ unexpected: true });
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: { code: "account_fenced" } });
  expect(access.isFenced).toHaveBeenCalledWith(owner);
  expect(claims).not.toHaveBeenCalled();

  const unavailable = await handle(new Request("http://localhost:3000/api/v1/records"),async () => {
    await admitDataRequest(owner,{},async () => limits,async () => ({ isFenced: async () => { throw new Error("secret backend URL"); } }));
    return Response.json({ unexpected: true });
  });
  expect(unavailable.status).toBe(503);
  const error = JSON.stringify(await unavailable.json());
  expect(error).toContain("account_state_unavailable");
  expect(error).not.toContain("secret backend URL");
});
