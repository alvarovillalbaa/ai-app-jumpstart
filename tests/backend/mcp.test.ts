import { afterEach, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { SqliteRepository } from "../../lib/data/sqlite";
import { RecordService } from "../../lib/data/service";
import { createMcpServer, mcpHandler } from "../../lib/mcp";
import { createHash } from "node:crypto";
import { vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());
it("speaks the MCP protocol with tools, resources and scoped mutations", async () => {
  const repo = new SqliteRepository(":memory:");
  const server = createMcpServer(new RecordService(repo, { tenant: "test", subject: "a", scopes: ["records:read", "records:write"] }));
  const client = new Client({ name: "contract-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote); await client.connect(local);
  try {
    expect((await client.listTools()).tools.map(t => t.name)).toContain("records_create");
    const creationKey = crypto.randomUUID(),input = { title: "From MCP",content: "Hello",creationKey };
    const created = await client.callTool({ name: "records_create", arguments: input });
    const content = created.content as { type: string; text: string }[];
    const record = JSON.parse(content[0].text);
    expect(await client.callTool({ name: "records_create",arguments: input })).toEqual(created);
    expect((await client.callTool({ name: "records_create",arguments: { ...input,content: "Changed" } })).isError).toBe(true);
    const status = await client.callTool({ name: "records_creation_status",arguments: { creationKey } });
    expect(JSON.parse((status.content as { text: string }[])[0].text)).toEqual({ status: "created",record });
    const resource = await client.readResource({ uri: `records:///${record.id}` });
    const item = resource.contents[0];
    expect("text" in item && JSON.parse(item.text).title).toBe("From MCP");
    const result = await client.callTool({ name: "records_update", arguments: { id: record.id, revision: 9, title: "Conflict", content: "" } });
    expect(result.isError).toBe(true);
  } finally { await client.close(); await server.close(); await repo.close(); }
});

it("initializes and calls tools over stateless authenticated Streamable HTTP", async () => {
  const token = "mcp-test-secret-".repeat(3);
  vi.stubEnv("APP_API_KEYS", JSON.stringify([{ sha256: createHash("sha256").update(token).digest("hex"), tenant: "test", subject: "reader", scopes: ["records:read"] }]));
  const repo = new SqliteRepository(":memory:");
  const handler = mcpHandler(async () => repo);
  const client = new Client({ name: "http-test", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const req = new Request(url, init);
      if (req.method !== "POST") return new Response(null, { status: 405 });
      return handler(req);
    },
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(6);
    const denied = await client.callTool({ name: "records_create", arguments: { title: "Denied", content: "" } });
    expect(denied.isError).toBe(true);
    const unauth = await handler(new Request("http://localhost:3000/api/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(unauth.status).toBe(401);
  } finally { await client.close(); await repo.close(); }
});

it("keeps stateless MCP record CRUD owner-scoped over authenticated HTTP",async () => {
  const ownerToken = "mcp-owner-secret-".repeat(3),otherToken = "mcp-other-secret-".repeat(3);
  vi.stubEnv("APP_API_KEYS",JSON.stringify([ownerToken,otherToken].map((token,index) => ({
    sha256: createHash("sha256").update(token).digest("hex"),tenant: "test",subject: `owner-${index}`,scopes: ["records:read","records:write"],
  }))));
  const repo = new SqliteRepository(":memory:"),handler = mcpHandler(async () => repo);
  async function connect(token: string) {
    const client = new Client({ name: "stateless-mcp-crud",version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp"),{
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: async (url,init) => {
        const request = new Request(url,init);
        return request.method === "POST" ? handler(request) : new Response(null,{ status: 405 });
      },
    }));
    return client;
  }
  const clients: Client[] = [];
  const text = (result: unknown) => {
    if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
      throw new Error("MCP result omitted its content.");
    }
    const block = result.content.find((item): item is { type: string;text: string } =>
      typeof item === "object" && item !== null && "type" in item && item.type === "text" &&
      "text" in item && typeof item.text === "string");
    if (!block) throw new Error("MCP result omitted its JSON payload.");
    return JSON.parse(block.text);
  };
  try {
    const owner = await connect(ownerToken);clients.push(owner);
    const other = await connect(otherToken);clients.push(other);
    const created = await owner.callTool({ name: "records_create",arguments: { title: "MCP private row",content: "Owner only",creationKey: crypto.randomUUID() } });
    expect(created.isError).not.toBe(true);
    const record = text(created);
    const fetched = await owner.callTool({ name: "records_get",arguments: { id: record.id } });
    expect(fetched.isError).not.toBe(true);
    expect(text(fetched)).toEqual(record);
    expect(text(await owner.callTool({ name: "records_list",arguments: {} })).items).toEqual([record]);
    const resource = (await owner.readResource({ uri: `records:///${record.id}` })).contents[0];
    expect("text" in resource ? JSON.parse(resource.text) : null).toEqual(record);

    const foreignList = await other.callTool({ name: "records_list",arguments: {} });
    expect(foreignList.isError).not.toBe(true);
    expect(text(foreignList).items).toEqual([]);
    expect((await other.callTool({ name: "records_get",arguments: { id: record.id } })).isError).toBe(true);
    await expect(other.readResource({ uri: `records:///${record.id}` })).rejects.toThrow();
    expect((await other.callTool({ name: "records_update",arguments: { id: record.id,revision: 1,title: "Stolen",content: "" } })).isError).toBe(true);
    expect((await other.callTool({ name: "records_delete",arguments: { id: record.id,revision: 1 } })).isError).toBe(true);

    const updated = await owner.callTool({ name: "records_update",arguments: { id: record.id,revision: 1,title: "MCP updated row",content: "Still private" } });
    expect(updated.isError).not.toBe(true);
    const current = text(updated);
    expect(current).toMatchObject({ id: record.id,title: "MCP updated row",content: "Still private",revision: 2 });
    expect((await other.callTool({ name: "records_get",arguments: { id: record.id } })).isError).toBe(true);
    expect((await owner.callTool({ name: "records_delete",arguments: { id: current.id,revision: current.revision } })).isError).not.toBe(true);
    expect(text(await owner.callTool({ name: "records_list",arguments: {} })).items).toEqual([]);
  } finally { await Promise.all(clients.map(client => client.close()));await repo.close(); }
});
