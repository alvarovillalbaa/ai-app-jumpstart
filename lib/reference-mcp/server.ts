import { createServer } from "node:http";
import { once } from "node:events";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const id = z.string().regex(/^[a-z0-9_-]{1,64}$/);
export const referenceCatalog = z.object({ schemaVersion: z.literal(1),label: z.string().min(1).max(120),
  items: z.array(z.object({ id,title: z.string().min(1).max(120),content: z.string().max(2000) }).strict()).max(100),
}).strict().refine(value => new Set(value.items.map(item => item.id)).size === value.items.length,"Catalog IDs must be unique.");
export type ReferenceCatalog = z.infer<typeof referenceCatalog>;

export async function startReferenceMcp(input: ReferenceCatalog,options: { port?: number;blockedProbe?: () => void } = {}) {
  if (process.env.NODE_ENV === "production") throw new Error("The reference MCP server is a local development fixture.");
  const catalog = referenceCatalog.parse(input),calls = { list: 0,get: 0 };
  let origin = "",active = 0;
  const server = createServer(async (request,response) => {
    if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin)) { response.writeHead(403).end();return; }
    if (request.url !== "/mcp") { response.writeHead(404).end();return; }
    if (request.method !== "POST") { response.writeHead(405,{ allow: "POST" }).end();return; }
    if (++active > 4) { active--;response.writeHead(503).end();return; }
    const timer = setTimeout(() => request.destroy(),5000);
    let mcp: McpServer|undefined,transport: WebStandardStreamableHTTPServerTransport|undefined;
    try {
      const chunks: Buffer[] = [];let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 16384) { response.writeHead(413).end();return; }
        chunks.push(chunk);
      }
      mcp = new McpServer({ name: "local-reference-catalog",version: "1" });
      const result = (value: unknown) => ({ content: [{ type: "text" as const,text: JSON.stringify(value) }] });
      mcp.registerTool("catalog_list",{ description: "Read bounded catalog item IDs and titles.",
        inputSchema: z.object({ offset: z.number().int().min(0).max(100).default(0),limit: z.number().int().min(1).max(10).default(5) }).strict(),
        annotations: { readOnlyHint: true,openWorldHint: false },
      },({ offset,limit }) => { calls.list++;return result({ schemaVersion: 1,label: catalog.label,items: catalog.items.slice(offset,offset+limit).map(({ id,title }) => ({ id,title })),
        nextOffset: offset+limit < catalog.items.length ? offset+limit : null }); });
      mcp.registerTool("catalog_get",{ description: "Read one bounded reference catalog item by ID.",inputSchema: z.object({ id }).strict(),annotations: { readOnlyHint: true,openWorldHint: false } },({ id }) => {
        calls.get++;const item = catalog.items.find(item => item.id === id);
        return item ? result({ schemaVersion: 1,label: catalog.label,item }) : { ...result({ error: "not_found" }),isError: true };
      });
      // Only runtime tests advertise this forbidden operation to prove filtering.
      if (options.blockedProbe) mcp.registerTool("catalog_delete",{ description: "Forbidden catalog deletion probe.",inputSchema: z.object({}).strict() },() => {
        options.blockedProbe!();return { ...result({ error: "forbidden" }),isError: true };
      });
      transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined,enableJsonResponse: true });
      await mcp.connect(transport);
      const headers = new Headers();
      for (const [name,value] of Object.entries(request.headers)) if (value) headers.set(name,Array.isArray(value) ? value.join(", ") : value);
      const output = await transport.handleRequest(new Request(`${origin}/mcp`,{ method: "POST",headers,body: Buffer.concat(chunks) }));
      output.headers.forEach((value,name) => response.setHeader(name,value));
      response.setHeader("cache-control","no-store");response.setHeader("x-content-type-options","nosniff");
      response.writeHead(output.status).end(Buffer.from(await output.arrayBuffer()));
    } catch { if (!response.headersSent) response.writeHead(400).end();else response.end(); }
    finally { clearTimeout(timer);active--;await transport?.close();await mcp?.close(); }
  });
  server.headersTimeout = 5000;server.requestTimeout = 5000;
  server.listen(options.port ?? 0,"127.0.0.1");await once(server,"listening");
  const address = server.address();if (!address || typeof address === "string") throw new Error("Reference MCP did not bind loopback.");
  origin = `http://127.0.0.1:${address.port}`;
  return { url: `${origin}/mcp`,calls,close: () => !server.listening ? Promise.resolve() : new Promise<void>((resolve,reject) => {
    server.close(error => error ? reject(error) : resolve());server.closeAllConnections();
  }) };
}
