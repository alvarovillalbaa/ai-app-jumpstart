import { createHash } from "node:crypto";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach,afterEach,expect,it,vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { preferenceHandlers } from "../../lib/http/account-preferences";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { defaultPreferences } from "../../lib/preferences/contract";
import { SqliteRepository } from "../../lib/data/sqlite";
import { mcpHandler } from "../../lib/mcp";
import { run } from "../../scripts/app-cli";

const alice = "alice-account-token-".repeat(3),bob = "bob-account-token-".repeat(3),key = "record-key-".repeat(5);
let store: ReturnType<typeof sqlitePreferenceStore>,repo: SqliteRepository,api: ReturnType<typeof preferenceHandlers>,handler: ReturnType<typeof mcpHandler>;
const clients: Client[] = [];
beforeEach(() => {
  for (const [name,value] of Object.entries({ AUTH_PROVIDER: "supabase",SUPABASE_AUTH_URL: "https://identity.example",SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",APP_ORIGIN: "http://localhost:3000",AI_CHAT_ENABLED: "false",UPLOAD_STORAGE_PROVIDER: "",
    APP_API_KEYS: JSON.stringify([{ sha256: createHash("sha256").update(key).digest("hex"),tenant: "supabase:https://identity.example",subject: "alice",scopes: ["records:read","records:write"] }]) })) vi.stubEnv(name,value);
  vi.stubGlobal("fetch",vi.fn(async (_url: unknown,init?: RequestInit) => {
    const token = new Headers(init?.headers).get("authorization"),id = token === `Bearer ${alice}` ? "alice" : token === `Bearer ${bob}` ? "bob" : null;
    return id ? Response.json({ id,role: "authenticated",is_anonymous: false,user_metadata: { tenant: "admin",subject: "alice" } }) : Response.json({ code: "session_not_found" },{ status: 401 });
  }));
  store = sqlitePreferenceStore(":memory:");repo = new SqliteRepository(":memory:");api = preferenceHandlers(async () => store);
  handler = mcpHandler(async () => repo,undefined,undefined,undefined,async () => store);
});
afterEach(async () => { for (const client of clients.splice(0)) await client.close();await store.close();await repo.close();vi.unstubAllGlobals();vi.unstubAllEnvs(); });
const request: typeof fetch = (url,init) => { const req = new Request(url,init);return req.method === "PATCH" ? api.update(req) : api.get(req); };
async function mcp(token: string) {
  const client = new Client({ name: "preference-test",version: "1" });clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp"),{ requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url,init) => init?.method === "POST" ? handler(new Request(url,init)) : Promise.resolve(new Response(null,{ status: 405 })),
  }));return client;
}
const value = (result: Awaited<ReturnType<Client["callTool"]>>) => { expect(result.isError).not.toBe(true);return JSON.parse((result.content as { text: string }[])[0].text); };

it("shares account preferences through REST, CLI and MCP without requiring enabled chat",async () => {
  expect(await run(["account","preferences"],{ APP_API_TOKEN: alice },request)).toEqual(defaultPreferences);
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-preference-cli-")),file = join(directory,"patch.json");
  try {
    await writeFile(file,JSON.stringify({ revision: 0,theme: "dark",soundVolume: 0.25 }));
    const saved = await run(["account","preferences","update",file],{ APP_API_TOKEN: alice },request);
    const client = await mcp(alice);
    expect(value(await client.callTool({ name: "account_preferences",arguments: {} }))).toEqual(saved);
    const resource = await client.readResource({ uri: "account:///preferences" });
    expect("text" in resource.contents[0] && JSON.parse(resource.contents[0].text)).toEqual(saved);
    expect(value(await client.callTool({ name: "account_preferences_update",arguments: { revision: 1,soundEnabled: true } }))).toMatchObject({ revision: 2,theme: "dark",soundEnabled: true,soundVolume: 0.25 });
    await expect(run(["account","preferences","update",file],{ APP_API_TOKEN: alice },request)).rejects.toThrow("HTTP 409");
    expect(await run(["account","preferences"],{ APP_API_TOKEN: bob },request)).toEqual(defaultPreferences);
    expect(value(await (await mcp(bob)).callTool({ name: "account_preferences",arguments: {} }))).toEqual(defaultPreferences);
  } finally { await rm(directory,{ recursive: true,force: true }); }
});

it("rejects owner injection, cross-origin writes, oversized bodies and record keys with matching owners",async () => {
  const req = (token: string,body: unknown,origin = "http://localhost:3000") => new Request("http://localhost:3000/api/v1/account/preferences",{ method: "PATCH",headers: { authorization: `Bearer ${token}`,"content-type": "application/json",origin },body: JSON.stringify(body) });
  expect((await api.update(req(alice,{ revision: 0,theme: "dark",subject: "bob" }))).status).toBe(400);
  expect((await api.update(req(alice,{ revision: 0,theme: "dark" },"https://foreign.example"))).status).toBe(403);
  expect((await api.update(req(alice,{ theme: "x".repeat(4100),revision: 0 }))).status).toBe(413);
  await expect(run(["account","preferences"],{ APP_API_TOKEN: key },request)).rejects.toThrow("HTTP 401");
  const client = await mcp(key);
  expect((await client.listTools()).tools.map(tool => tool.name)).not.toContain("account_preferences");
  expect((await client.callTool({ name: "account_preferences_update",arguments: { revision: 0,theme: "dark" } })).isError).toBe(true);
  expect(await run(["account","preferences"],{ APP_API_TOKEN: alice },request)).toEqual(defaultPreferences);
});
