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
    const created = await client.callTool({ name: "records_create", arguments: { title: "From MCP", content: "Hello" } });
    const content = created.content as { type: string; text: string }[];
    const record = JSON.parse(content[0].text);
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
    expect((await client.listTools()).tools).toHaveLength(5);
    const denied = await client.callTool({ name: "records_create", arguments: { title: "Denied", content: "" } });
    expect(denied.isError).toBe(true);
    const unauth = await handler(new Request("http://localhost:3000/api/mcp", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));
    expect(unauth.status).toBe(401);
  } finally { await client.close(); await repo.close(); }
});
