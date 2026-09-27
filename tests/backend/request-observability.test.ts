import { afterEach, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { handle } from "../../lib/http/handler";
import { currentRequestId, failureDiagnostic } from "../../lib/observability/request";
import { mcpHandler } from "../../lib/mcp";
import { SqliteRepository } from "../../lib/data/sqlite";
import { ConversationBroker } from "../../lib/agent-access/broker";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { readPublicFailure } from "../../lib/http/public-failure";
import { run } from "../../scripts/app-cli";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
type DiagnosticLog = { event: string; requestId: string; code?: string; method?: string; status?: number };
function logs(spy: { mock: { calls: readonly (readonly unknown[])[] } }): DiagnosticLog[] {
  return spy.mock.calls.map(call => JSON.parse(String(call[0])) as DiagnosticLog);
}

it("isolates asynchronous request failures and ignores spoofed IDs without logging private input", async () => {
  const capture = vi.spyOn(console, "info").mockImplementation(() => {});
  const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const ids: (string | undefined)[] = [];
  const spoof = randomUUID();
  const responses = [0, 1].map(index => handle(new Request(`http://localhost:3000/private-owner?secret=query-${index}`, {
    method: "POST", body: `private-prompt-${index}`, headers: { authorization: `Bearer private-token-${index}`, "x-request-id": spoof },
  }), async () => {
    ids[index] = currentRequestId();
    await gates[index].promise;
    expect(currentRequestId()).toBe(ids[index]);
    failureDiagnostic("mcp_tool_failed", new Error(`provider://private-exception-${index}`));
    throw new Error(`private-exception-${index}`);
  }));
  gates[1].resolve(); const second = await responses[1]; gates[0].resolve(); const first = await responses[0];
  for (const [index, response] of [first, second].entries()) {
    expect(response.status).toBe(500);
    expect(response.headers.get("x-request-id")).toBe(ids[index]);
    expect((await response.json()).error.requestId).toBe(ids[index]);
    expect(ids[index]).not.toBe(spoof);
  }
  expect(ids[0]).not.toBe(ids[1]); expect(currentRequestId()).toBeUndefined();
  const events = logs(capture);
  expect(events.filter(row => row.event === "mcp_tool_failed").map(row => row.requestId)).toEqual([ids[1], ids[0]]);
  expect(JSON.stringify(events)).not.toMatch(/private-|query-|provider:\/\/|Bearer/);
  expect(events.filter(row => row.event === "http_request")).toHaveLength(2);
});

it("correlates real MCP tool/resource failures to their HTTP envelope, including HTTP-200 tool denial", async () => {
  const capture = vi.spyOn(console, "info").mockImplementation(() => {});
  const token = "fixture-mcp-observability-".repeat(3);
  vi.stubEnv("AUTH_PROVIDER", "api-key");
  vi.stubEnv("APP_API_KEYS", JSON.stringify([{ sha256: createHash("sha256").update(token).digest("hex"), tenant: "test", subject: "reader", scopes: ["records:read"] }]));
  const repo = new SqliteRepository(":memory:");
  const handler = mcpHandler(async () => repo);
  const client = new Client({ name: "correlation-contract", version: "1" });
  let responseId: string | null = null, status = 0;
  const transport = new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp?private-query=yes"), {
    requestInit: { headers: { authorization: `Bearer ${token}`, "x-request-id": "caller-must-not-control-this" } },
    fetch: async (url, init) => {
      const request = new Request(url, init);
      if (request.method !== "POST") return new Response(null, { status: 405 });
      const response = await handler(request); responseId = response.headers.get("x-request-id"); status = response.status; return response;
    },
  });
  try {
    await client.connect(transport);
    const denied = await client.callTool({ name: "records_create", arguments: { title: "Private title", content: "Private prompt" } });
    expect(status).toBe(200); expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toEqual({ error: { code: "forbidden", requestId: responseId } });
    expect(JSON.stringify(denied.content)).toContain(responseId);
    try { await client.readResource({ uri: `records:///${randomUUID()}` }); throw new Error("Expected denial"); }
    catch (error) { expect(error).toMatchObject({ data: { requestId: responseId } }); }
    vi.spyOn(repo, "list").mockRejectedValue(new Error("postgresql://private-secret@database"));
    const failed = await client.callTool({ name: "records_list", arguments: {} });
    expect(failed.structuredContent).toEqual({ error: { code: "internal_error", requestId: responseId } });
    expect(JSON.stringify(failed)).not.toContain("private-secret");
    expect(logs(capture).filter(row => row.event === "mcp_tool_failed")).toHaveLength(2);
    expect(logs(capture).some(row => row.event === "mcp_resource_failed")).toBe(true);
    expect(JSON.stringify(logs(capture))).not.toMatch(/private-query|Private prompt|Private title|postgresql|fixture-mcp-observability/);
  } finally { await client.close(); await repo.close(); }
});

it("logs an ambiguous start once with the request ID without redispatch or private error details", async () => {
  const capture = vi.spyOn(console, "info").mockImplementation(() => {});
  const store = sqliteAccessStore(":memory:");
  const dispatch = vi.fn(async () => { throw new Error("https://private-runtime?credential=private-secret"); });
  const broker = new ConversationBroker(store, dispatch), owner = { tenant: "private-tenant", subject: "private-subject" };
  const input = { operationId: randomUUID(), message: "private-prompt" };
  try {
    const response = await handle(new Request("http://localhost:3000/api/v1/conversations"), async () => Response.json(await broker.create(owner, input)));
    expect(await response.json()).toMatchObject({ status: "starting", sessionId: null });
    expect(await broker.create(owner, input)).toMatchObject({ status: "starting" });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const event = logs(capture).find(row => row.event === "runtime_creation_unacknowledged");
    expect(event).toEqual({ event: "runtime_creation_unacknowledged", requestId: response.headers.get("x-request-id"), code: "internal_error" });
    expect(JSON.stringify(logs(capture))).not.toContain("private-");
  } finally { await store.close(); }
});

it("shows the CLI's public failure code and request reference while dropping provider messages", async () => {
  const id = randomUUID();
  const request: typeof fetch = async () => Response.json({ error: { code: "creation_conflict", requestId: id, message: "private-provider-exception" } }, {
    status: 409, headers: { "x-request-id": id },
  });
  await expect(run(["list"], { APP_API_TOKEN: "fixture-token" }, request)).rejects.toThrow(`HTTP 409: creation_conflict (reference: ${id})`);
  const proxy: typeof fetch = async () => Response.json({ error: { code: "private_provider_secret", message: "private-provider-exception" } }, { status: 502 });
  await expect(run(["list"], { APP_API_TOKEN: "fixture-token" }, proxy)).rejects.toThrow("HTTP 502: request_failed");
});

it("refuses conflicting/invalid IDs and cancels oversized error bodies", async () => {
  const id = randomUUID(), other = randomUUID();
  expect(await readPublicFailure(Response.json({ error: { code: "daily_limit", requestId: other } }, { headers: { "x-request-id": id } })))
    .toEqual({ code: "daily_limit" });
  expect(await readPublicFailure(Response.json({ error: { code: "not_found", requestId: "private-invalid-id" } })))
    .toEqual({ code: "not_found" });
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("private-".repeat(1200))); }, cancel });
  expect(await readPublicFailure(new Response(body, { status: 500, headers: { "content-type": "application/json", "x-request-id": id } })))
    .toEqual({ code: "request_failed", requestId: id });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(await readPublicFailure(new Response("private-proxy-html", { status: 502, headers: { "content-type": "text/html" } }))).toEqual({ code: "request_failed" });
  const cancelHtml = vi.fn();
  const html = new ReadableStream({ cancel: cancelHtml });
  expect(await readPublicFailure(new Response(html, { headers: { "content-type": "text/html" } }))).toEqual({ code: "request_failed" });
  expect(cancelHtml).toHaveBeenCalledTimes(1);
});

it("does not log arbitrary HTTP method text", async () => {
  const capture = vi.spyOn(console, "info").mockImplementation(() => {});
  await handle(new Request("http://localhost:3000/api", { method: "PRIVATE-TOKEN" }), async () => new Response());
  expect(logs(capture)).toEqual([expect.objectContaining({ event: "http_request", method: "OTHER", status: 200 })]);
  expect(JSON.stringify(logs(capture))).not.toContain("PRIVATE-TOKEN");
});
