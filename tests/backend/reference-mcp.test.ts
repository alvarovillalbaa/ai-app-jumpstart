import { afterEach,expect,it } from "vitest";
import { request as httpRequest } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { referenceMcpUrl } from "../../lib/reference-mcp/config";
import { referenceCatalog,startReferenceMcp } from "../../lib/reference-mcp/server";

const catalog = { schemaVersion: 1 as const,label: "Operator-owned reference",items: Array.from({ length: 12 },(_,i) => ({ id: `item-${i}`,title: `Item ${i}`,content: `Reference ${i}` })) };
let service: Awaited<ReturnType<typeof startReferenceMcp>>|undefined,client: Client|undefined;
afterEach(async () => { await client?.close();await service?.close();client = undefined;service = undefined; });
it("has no unconfigured connection and requires a canonical development loopback endpoint",() => {
  expect(referenceMcpUrl({ NODE_ENV: "production" })).toBeNull();
  expect(referenceMcpUrl({ NODE_ENV: "development",REFERENCE_MCP_URL: "http://127.0.0.1:3191/mcp" })).toBe("http://127.0.0.1:3191/mcp");
  expect(() => referenceMcpUrl({ NODE_ENV: "production",REFERENCE_MCP_URL: "http://127.0.0.1:3191/mcp" })).toThrow("development");
  for (const url of ["https://example.com/mcp","http://localhost:3191/mcp","http://169.254.169.254:3191/mcp","http://127.1:3191/mcp",
    "http://2130706433:3191/mcp","http://127.0.0.1:03191/mcp","http://127.0.0.1:80/mcp","http://127.0.0.1:3191/other",
    "http://user:password@127.0.0.1:3191/mcp","http://127.0.0.1:3191/mcp?","http://127.0.0.1:3191/mcp#", " http://127.0.0.1:3191/mcp"])
    expect(() => referenceMcpUrl({ NODE_ENV: "development",REFERENCE_MCP_URL: url })).toThrow();
});
it("serves real bounded read-only SDK calls without modifying the catalog",async () => {
  service = await startReferenceMcp(catalog);client = new Client({ name: "reference-contract",version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url)));
  expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual(["catalog_get","catalog_list"]);
  const page = await client.callTool({ name: "catalog_list",arguments: { limit: 10 } });
  expect(page.isError).not.toBe(true);const value = JSON.parse((page.content as { text: string }[])[0].text);
  expect(value.items).toHaveLength(10);expect(value.nextOffset).toBe(10);expect(value.items[0]).not.toHaveProperty("content");
  const found = await client.callTool({ name: "catalog_get",arguments: { id: "item-0" } });
  expect(JSON.parse((found.content as { text: string }[])[0].text).item).toEqual(catalog.items[0]);
  expect((await client.callTool({ name: "catalog_list",arguments: { limit: 1000 } })).isError).toBe(true);
  expect((await client.callTool({ name: "catalog_get",arguments: { id: "missing" } })).isError).toBe(true);
  expect((await client.callTool({ name: "catalog_delete",arguments: {} })).isError).toBe(true);
  expect(service.calls).toEqual({ list: 1,get: 2 });
});
it("rejects hostile origins/hosts and oversized requests on the loopback server",async () => {
  service = await startReferenceMcp(catalog);
  expect((await fetch(service.url,{ method: "POST",headers: { origin: "https://hostile.example" },body: "{}" })).status).toBe(403);
  const hostileHost = await new Promise<number|undefined>((resolve,reject) => {
    const req = httpRequest(service!.url,{ method: "POST",headers: { host: "hostile.example" } },response => { response.resume();resolve(response.statusCode); });
    req.on("error",reject);req.end("{}");
  });
  expect(hostileHost).toBe(403);
  expect((await fetch(service.url,{ method: "POST",headers: { "content-type": "application/json" },body: "x".repeat(17000) })).status).toBe(413);
});
it("requires unique catalog identities and bounds records before serving",() => {
  expect(referenceCatalog.safeParse({ ...catalog,items: [catalog.items[0],catalog.items[0]] }).success).toBe(false);
  expect(referenceCatalog.safeParse({ ...catalog,items: [{ ...catalog.items[0],content: "x".repeat(2001) }] }).success).toBe(false);
});
