import { createHash } from "node:crypto";
import { mkdtemp,readFile,rm,stat,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,expect,it,vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { run } from "../../scripts/app-cli";
import { uploadHandlers } from "../../lib/http/uploads";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { localUploadObjects } from "../../lib/uploads/local";
import { createMcpServer,mcpHandler } from "../../lib/mcp";
import { UploadService } from "../../lib/uploads/service";
import { SqliteRepository } from "../../lib/data/sqlite";
import { RecordService } from "../../lib/data/service";
import { UploadIntake } from "../../lib/uploads/intake";

const token = "upload-cli-owner-token-".repeat(3);
afterEach(() => vi.unstubAllEnvs());

it("uses the authenticated binary HTTP path from CLI for put, list, get and delete",async () => {
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","scan-on-read");
  vi.stubEnv("APP_API_KEYS",JSON.stringify([{ sha256: createHash("sha256").update(token).digest("hex"),
    tenant: "test",subject: "alice",scopes: ["uploads:read","uploads:write","uploads:download"] }]));
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-upload-cli-")),file = join(directory,"note.txt");
  await writeFile(file,"cli secret bytes");
  const catalog = sqliteUploadCatalog(":memory:"),api = uploadHandlers(async () => catalog,
    async () => localUploadObjects(join(directory,"objects")),async () => ({ scan: async () => "clean" }));
  const request: typeof fetch = (url,init) => {
    const req = new Request(url,init),id = new URL(req.url).pathname.split("/")[4];
    if (req.method === "POST") return api.create(req);
    if (req.method === "DELETE") return api.delete(req,id);
    if (new URL(req.url).pathname.endsWith("/download")) return api.download(req,id);
    return id ? api.get(req,id) : api.list(req);
  };
  const env = { APP_API_TOKEN: token };
  try {
    const row = await run(["uploads","put",file],env,request) as { id: string;state: string };
    expect(row.state).toBe("quarantined");
    expect(await run(["uploads","list"],env,request)).toMatchObject({ items: [{ id: row.id }],usage: { files: 1 } });
    expect(await run(["uploads","get",row.id],env,request)).toMatchObject({ id: row.id,state: "quarantined" });
    const output = join(directory,"download.txt");
    expect(await run(["uploads","download",row.id,output],env,request)).toMatchObject({ file: output,size: 16 });
    expect(await readFile(output,"utf8")).toBe("cli secret bytes");
    expect((await stat(output)).mode & 0o077).toBe(0);
    await expect(run(["uploads","download",row.id,output],env,request)).rejects.toThrow("already exists");
    expect(await run(["uploads","delete",row.id],env,request)).toEqual({ deleted: true });
    expect(await run(["uploads","list"],env,request)).toEqual({ items: [],usage: { files: 0,bytes: 0 } });
    await expect(run(["uploads","get",row.id],env,request)).rejects.toThrow("HTTP 404");
  } finally { await catalog.close();await rm(directory,{ recursive: true,force: true }); }
});

it("exposes only owned quarantine metadata through MCP tools and resources",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-upload-mcp-"));
  const catalog = sqliteUploadCatalog(":memory:"),objects = localUploadObjects(directory),repo = new SqliteRepository(":memory:");
  const owner = { tenant: "test",subject: "alice" },principal = { ...owner,scopes: ["uploads:read","uploads:write"] };
  const intake = new UploadIntake(catalog,objects);
  const row = await intake.accept(owner,"note.txt","text/plain",new TextEncoder().encode("secret bytes"));
  const uploads = new UploadService(catalog,async () => objects,principal);
  const server = createMcpServer(new RecordService(repo,principal),undefined,undefined,undefined,uploads);
  const client = new Client({ name: "upload-contract",version: "1" });
  const [local,remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);await client.connect(local);
  try {
    const names = (await client.listTools()).tools.map(item => item.name);
    expect(names).toContain("uploads_get");
    expect(names).not.toContain("uploads_download");
    const found = await client.callTool({ name: "uploads_get",arguments: { id: row.id } });
    expect(JSON.stringify(found.content)).toContain("quarantined");
    expect(JSON.stringify(found.content)).not.toContain("secret bytes");
    const resource = await client.readResource({ uri: `uploads:///${row.id}` });
    expect(JSON.stringify(resource.contents)).toContain(row.id);
    expect(JSON.stringify(resource.contents)).not.toContain("secret bytes");
    const deleted = await client.callTool({ name: "uploads_delete",arguments: { id: row.id } });
    expect(deleted.isError).not.toBe(true);
    expect(await catalog.list(owner)).toEqual([]);
  } finally { await client.close();await server.close();await repo.close();await catalog.close();await rm(directory,{ recursive: true,force: true }); }
});

it("routes upload-only API credentials through stateless MCP HTTP",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-upload-mcp-http-"));
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("UPLOAD_STORAGE_PROVIDER","local");
  vi.stubEnv("UPLOAD_LOCAL_ROOT",directory);
  vi.stubEnv("APP_API_KEYS",JSON.stringify([{ sha256: createHash("sha256").update(token).digest("hex"),
    tenant: "test",subject: "alice",scopes: ["uploads:read","uploads:write"] }]));
  const catalog = sqliteUploadCatalog(":memory:"),repo = new SqliteRepository(":memory:");
  const owner = { tenant: "test",subject: "alice" };
  const row = await new UploadIntake(catalog,localUploadObjects(directory)).accept(owner,"note.txt","text/plain",new TextEncoder().encode("private"));
  const handler = mcpHandler(async () => repo,undefined,undefined,async () => catalog);
  const client = new Client({ name: "upload-http-contract",version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp"),{
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url,init) => handler(new Request(url,init)),
  });
  try {
    await client.connect(transport);
    expect((await client.listTools()).tools.map(tool => tool.name)).toContain("uploads_list");
    const listed = await client.callTool({ name: "uploads_list",arguments: {} });
    expect(JSON.stringify(listed.content)).toContain(row.id);
    const denied = await client.callTool({ name: "records_list",arguments: {} });
    expect(denied.isError).toBe(true);
    const deleted = await client.callTool({ name: "uploads_delete",arguments: { id: row.id } });
    expect(deleted.isError).not.toBe(true);
    expect(await catalog.list(owner)).toEqual([]);
  } finally { await client.close();await repo.close();await catalog.close();await rm(directory,{ recursive: true,force: true }); }
});
