import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { artifactHandlers } from "../../lib/http/artifacts";
import { conversationHandlers } from "../../lib/http/conversations";
import { mcpHandler } from "../../lib/mcp";
import { run } from "../../scripts/app-cli";

const alice = "alice-user-token-".repeat(4), bob = "bob-user-token-".repeat(4), key = "record-only-key-".repeat(4);
const owner = { tenant: "supabase:https://identity.example",subject: "alice" };
let store: ReturnType<typeof sqliteAccessStore>, repo: SqliteRepository, id: string;
let budget: ReturnType<typeof sqliteBudgetStore>;
let api: ReturnType<typeof conversationHandlers>, handler: ReturnType<typeof mcpHandler>;
const clients: Client[] = [];
beforeEach(async () => {
  const env = { AUTH_PROVIDER: "supabase",SUPABASE_AUTH_URL: "https://identity.example",SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_fixture",AI_CHAT_ENABLED: "true",AI_RUNTIME_ORIGIN: "http://127.0.0.1:4274",
    AI_CREATION_SIGNING_JSON: JSON.stringify({ audience: "fixture",activeKey: "one",keys: { one: "a".repeat(64) } }),
    AI_BUDGET_POLICY_JSON: JSON.stringify({ policy: { id: "fixture",dailyMicros: 60,maxActive: 2,maxPerMinute: 20 },estimateMicros: 20,maxModelCalls: 1,modelIds: ["fixture"],
      costBasis: { sourceUrl: "https://example.test/fixture-prices", reviewedAt: "2026-09-24", maxOtherMicros: 0,
        models: [{ id: "fixture", maxInputTokens: 1, maxOutputTokens: 1, inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 }] } }),
    APP_API_KEYS: JSON.stringify([{ ...owner,sha256: createHash("sha256").update(key).digest("hex"),scopes: ["records:read","records:write"] }]),APP_ORIGIN: "http://localhost:3000" };
  for (const [name,value] of Object.entries(env)) vi.stubEnv(name,value);
  vi.stubGlobal("fetch",vi.fn(async (_url: unknown,init?: RequestInit) => {
    const token = new Headers(init?.headers).get("authorization");
    const subject = token === `Bearer ${alice}` ? "alice" : token === `Bearer ${bob}` ? "bob" : null;
    return subject ? Response.json({ id: subject,role: "authenticated",is_anonymous: false,user_metadata: { subject: "alice",credentialType: "user" } }) : Response.json({ msg: "Revoked",code: "session_not_found" },{ status: 401 });
  }));
  store = sqliteAccessStore(":memory:"); repo = new SqliteRepository(":memory:"); id = randomUUID();
  await store.reserve({ ...owner,id: randomUUID(),operationId: id,requestHash: "b".repeat(64) },"Initial private title");
  budget = sqliteBudgetStore(":memory:");
  api = conversationHandlers(async () => store); handler = mcpHandler(async () => repo,async () => store,async () => budget);
});
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); await store.close(); await repo.close(); await budget.close();vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const request: typeof fetch = async (url,init) => {
  const req = new Request(url,init), path = new URL(req.url).pathname.split("/");
  if (path[5] === "runs") return api.runs(req,path[4]);
  return req.method === "PATCH" ? api.update(req,path[4]) : path[4] ? api.get(req,path[4]) : api.list(req);
};
async function mcp(token: string) {
  const client = new Client({ name: "history-contract",version: "1" }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url,init) => init?.method === "POST" ? handler(new Request(url,init)) : new Response(null,{ status: 405 }),
  }));
  return client;
}
function value(result: Awaited<ReturnType<Client["callTool"]>>) {
  expect(result.isError).not.toBe(true);
  return JSON.parse((result.content as { type: "text";text: string }[])[0].text);
}

it.each(["true","false"])("shares reads and edits across CLI, REST and stateless MCP with chat enabled=%s",async enabled => {
  vi.stubEnv("AI_CHAT_ENABLED",enabled);
  const client = await mcp(alice), env = { APP_API_TOKEN: alice };
  expect((await client.listTools()).tools.map(tool => tool.name)).toContain("conversations_update");
  const listed = value(await client.callTool({ name: "conversations_list",arguments: {} }));
  expect(listed.items).toHaveLength(1);
  const row = await run(["conversations","get",id],env,request);
  expect(row).toEqual(listed.items[0]); expect(row).not.toHaveProperty("sessionId"); expect(row).not.toHaveProperty("requestHash");
  const renamed = value(await client.callTool({ name: "conversations_update",arguments: { operationId: id,patch: { revision: 1,title: "MCP title" } } }));
  expect(renamed).toMatchObject({ title: "MCP title",revision: 2 });
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-history-cli-"));
  try {
    const file = join(directory,"patch.json"); await writeFile(file,JSON.stringify({ revision: 1,archived: true }));
    await expect(run(["conversations","update",id,file],env,request)).rejects.toThrow("HTTP 409: conversation_changed");
    await writeFile(file,JSON.stringify({ revision: 2,archived: true }));
    expect(await run(["conversations","update",id,file],env,request)).toMatchObject({ archived: true,revision: 3 });
    expect(await run(["conversations","list"],env,request)).toMatchObject({ items: [] });
    expect(await run(["conversations","list","--archived","--limit","1"],env,request)).toMatchObject({ items: [{ operationId: id,revision: 3 }] });
    const resource = await client.readResource({ uri: `conversations:///${id}` });
    expect("text" in resource.contents[0] && JSON.parse(resource.contents[0].text)).toMatchObject({ title: "MCP title",archived: true,revision: 3 });
  } finally { await rm(directory,{ recursive: true }); }
});

it("allows only the artifact owner to erase it through MCP and blocks same-call replay",async () => {
  await store.bind(owner,id,"artifact-session");
  const draft = { title: "Private note",content: "Remove this text" };
  const saved = await store.saveArtifact(owner,id,"artifact-session","artifact-call",draft);
  if (saved.status !== "created") throw new Error("Fixture artifact was not created.");
  const artifactId = saved.artifact.id;
  const foreign = await mcp(bob);
  expect((await foreign.callTool({ name: "artifacts_delete",arguments: { id: artifactId } })).isError).toBe(true);
  expect(await store.getArtifact(owner,artifactId)).toEqual(saved.artifact);
  const client = await mcp(alice);
  expect(value(await client.callTool({ name: "artifacts_delete",arguments: { id: artifactId } }))).toEqual({ deleted: true });
  expect((await client.callTool({ name: "artifacts_get",arguments: { id: artifactId } })).isError).toBe(true);
  expect(await store.saveArtifact(owner,id,"artifact-session","artifact-call",draft)).toEqual({ status: "unavailable" });
});

it.each(["true","false"])("denies foreign access and matching-owner record keys with chat enabled=%s",async enabled => {
  vi.stubEnv("AI_CHAT_ENABLED",enabled);
  const foreign = await mcp(bob);
  expect(value(await foreign.callTool({ name: "conversations_list",arguments: {} })).items).toEqual([]);
  for (const tool of ["conversations_get","conversations_update","conversations_runs"]) {
    expect((await foreign.callTool({ name: tool,arguments: { operationId: id,...(tool.endsWith("update") ? { patch: { revision: 1,title: "Stolen" } } : {}) } })).isError).toBe(true);
  }
  await expect(foreign.readResource({ uri: `conversations:///${id}` })).rejects.toThrow("Conversation unavailable");
  await expect(run(["conversations","get",id],{ APP_API_TOKEN: bob },request)).rejects.toThrow("HTTP 404");
  const recordClient = await mcp(key);
  expect((await recordClient.listTools()).tools.map(tool => tool.name)).not.toContain("conversations_list");
  expect((await recordClient.listTools()).tools.map(tool => tool.name)).not.toContain("usage_get");
  expect((await recordClient.listTools()).tools.map(tool => tool.name)).not.toContain("usage_reservations");
  expect((await recordClient.listTools()).tools.map(tool => tool.name)).not.toContain("usage_corrections");
  expect((await recordClient.callTool({ name: "conversations_get",arguments: { operationId: id } })).isError).toBe(true);
  await expect(run(["conversations","get",id],{ APP_API_TOKEN: key },request)).rejects.toThrow("HTTP 401");
  expect((await recordClient.listTools()).tools.map(tool => tool.name)).not.toContain("conversations_runs");
  await expect(run(["conversations","runs",id],{ APP_API_TOKEN: key },request)).rejects.toThrow("HTTP 401");
  await expect(run(["conversations","runs",id],{ APP_API_TOKEN: bob },request)).rejects.toThrow("HTTP 404");
  expect(await run(["conversations","runs",id],{ APP_API_TOKEN: alice },request)).toMatchObject({ source: "eve-run-boundaries",items: [] });
  expect((await api.runs(new Request(`http://localhost:3000/api/v1/conversations/${id}/runs?limit=51`,{ headers: { authorization: `Bearer ${alice}` } }),id)).status).toBe(400);
  expect((await store.getDetails(owner,id))?.revision).toBe(1);
});

it("retains saved-data capabilities while removing runtime tools when chat is paused, and rechecks revocation",async () => {
  const client = await mcp(alice);
  vi.stubEnv("AI_CHAT_ENABLED","false");
  const tools = (await client.listTools()).tools;
  expect(tools.map(tool => tool.name)).toContain("account_profile");
  expect(tools.map(tool => tool.name)).toContain("artifacts_get");
  expect(tools.map(tool => tool.name)).not.toContain("conversations_source_events");
  expect(tools.map(tool => tool.name)).not.toContain("conversations_reconcile");
  expect(tools.map(tool => tool.name)).toContain("usage_get");
  vi.stubEnv("AI_BUDGET_POLICY_JSON","invalid disabled configuration");
  vi.stubEnv("AI_CREATION_SIGNING_JSON","");
  expect(value(await client.callTool({ name: "usage_get",arguments: {} }))).toMatchObject({ dailyLimitMicros: null });
  expect(value(await client.callTool({ name: "conversations_get",arguments: { operationId: id } }))).toMatchObject({ title: "Initial private title" });
  expect(await run(["conversations","get",id],{ APP_API_TOKEN: alice },request)).toMatchObject({ title: "Initial private title" });
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue(Response.json({ msg: "Revoked",code: "session_not_found" },{ status: 401 })));
  await expect(client.listTools()).rejects.toThrow();
});

it("rejects owner/control-field injection and invalid CLI arguments without writes",async () => {
  const client = await mcp(alice);
  for (const patch of [{ revision: 1 },{ revision: 1,title: "Changed",subject: "bob" },{ revision: 1,archived: true,sessionId: "forged" }]) {
    expect((await client.callTool({ name: "conversations_update",arguments: { operationId: id,patch } })).isError).toBe(true);
  }
  const spy = vi.fn<typeof fetch>();
  for (const args of [["list","--limit","51"],["list","--archived","--archived"],["list","--cursor"],["get","not-a-uuid"],["list","--subject","alice"]]) {
    await expect(run(["conversations",...args],{ APP_API_TOKEN: alice },spy)).rejects.toThrow();
  }
  expect(spy).not.toHaveBeenCalled();
  expect((await store.getDetails(owner,id))?.revision).toBe(1);
});

it.each(["true","false"])("shares artifact versions through REST, CLI and MCP while fencing keys and stale owners with chat enabled=%s",async enabled => {
  vi.stubEnv("AI_CHAT_ENABLED",enabled);
  await store.bind(owner,id,"versions-session");
  const draft = { title: "Original",content: "Approved original" };
  const saved = await store.saveArtifact(owner,id,"versions-session","versions-call",draft);
  if (saved.status !== "created") throw new Error("Fixture not created");
  const artifactId = saved.artifact.id,api = artifactHandlers(async () => store);
  const request: typeof fetch = async (url,init) => {
    const req = new Request(url,init),path = new URL(String(url)).pathname;
    if (path.endsWith("/versions")) return api.versions(req,artifactId);
    return init?.method === "PATCH" ? api.update(req,artifactId) : api.get(req,artifactId);
  };
  const client = await mcp(alice),foreign = await mcp(bob),recordKey = await mcp(key);
  expect(value(await client.callTool({ name: "artifacts_update",arguments: { id: artifactId,revision: 1,title: "MCP edit",content: "Version two" } }))).toMatchObject({ revision: 2,content: "Version two" });
  expect((await foreign.callTool({ name: "artifacts_update",arguments: { id: artifactId,revision: 2,...draft } })).isError).toBe(true);
  expect((await recordKey.listTools()).tools.map(tool => tool.name)).not.toContain("artifacts_update");
  expect((await api.versions(new Request(`http://localhost:3000/api/v1/artifacts/${artifactId}/versions`,{ headers: { authorization: `Bearer ${key}` } }),artifactId)).status).toBe(401);
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-artifact-cli-"));
  try {
    const file = join(directory,"patch.json");await writeFile(file,JSON.stringify({ revision: 2,title: "CLI edit",content: "Version three" }));
    expect(await run(["artifacts","update",artifactId,file],{ APP_API_TOKEN: alice },request)).toMatchObject({ revision: 3,content: "Version three" });
    await expect(run(["artifacts","update",artifactId,file],{ APP_API_TOKEN: alice },request)).rejects.toThrow("HTTP 409");
    expect(await run(["artifacts","versions",artifactId,"--limit","2"],{ APP_API_TOKEN: alice },request)).toEqual(value(await client.callTool({ name: "artifacts_versions",arguments: { id: artifactId,limit: 2 } })));
    expect(await run(["artifacts","versions",artifactId,"--before","2"],{ APP_API_TOKEN: alice },request)).toEqual({ items: [saved.artifact],nextBefore: null });
  } finally { await rm(directory,{ recursive: true,force: true }); }
  expect(await store.saveArtifact(owner,id,"versions-session","versions-call",draft)).toEqual({ status: "existing",artifact: saved.artifact });
});
