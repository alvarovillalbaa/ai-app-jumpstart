import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { recordInput, recordUpdate } from "./data/contract";
import { RecordService } from "./data/service";
import { authenticate } from "./http/auth";
import { AppError } from "./http/errors";
import { handle, readJson } from "./http/handler";
import { getRepository } from "./data/repository";
import type { RecordRepository } from "./data/contract";
import { ConversationHistoryService } from "./agent-access/history";
import { historyOptions, historyPatch, operationId, type SessionAccessStore } from "./agent-access/contract";
import { getSessionAccessStore } from "./agent-access/store";
import { chatSettings } from "./agent-access/settings";
import { projectionOptions } from "./agent-access/projection-contract";
import { ArtifactService } from "./agent-access/artifacts";
import { artifactOptions } from "./agent-access/artifact-contract";
import { UsageService } from "./budgets/usage";
import { getBudgetStore } from "./budgets/store";
import type { BudgetStore } from "./budgets/contract";
import { UploadService } from "./uploads/service";
import { getUploadCatalog } from "./uploads/catalog-store";
import { createUploadObjects } from "./uploads/objects-store";
import type { UploadCatalog } from "./uploads/catalog-contract";

export function createMcpServer(service: RecordService, history?: ConversationHistoryService,artifacts?: ArtifactService,usage?: UsageService,uploads?: UploadService) {
  const server = new McpServer({ name: "ai-app-jumpstart-data", version: "1.0.0" });
  async function result(action: () => Promise<unknown>) {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await action()) }] }; }
    catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: error instanceof AppError ? error.message : "Operation failed. Check the input and try again." }] };
    }
  }
  server.registerTool("records_list", {
    description: "List records owned by the authenticated caller. Cursor order is record ID.",
    inputSchema: { limit: z.number().int().min(1).max(100).optional(), after: z.string().uuid().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, input => result(() => service.list(input)));
  server.registerTool("records_get", {
    description: "Read one owned record.", inputSchema: { id: z.string().uuid() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, ({ id }) => result(() => service.get(id)));
  server.registerTool("records_create", {
    description: "Create a private record. Each invocation creates a new record; do not retry blindly.",
    inputSchema: recordInput, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, input => result(() => service.create(input)));
  server.registerTool("records_update", {
    description: "Replace a private record using its current revision. Refresh on conflict.",
    inputSchema: recordUpdate.extend({ id: z.string().uuid() }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ id, ...input }) => result(() => service.update(id, input)));
  server.registerTool("records_delete", {
    description: "Permanently delete a private record at its current revision.",
    inputSchema: { id: z.string().uuid(), revision: z.number().int().positive() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }, ({ id, revision }) => result(async () => { await service.delete(id, revision); return { deleted: true }; }));
  server.registerResource("record", new ResourceTemplate("records:///{id}", { list: undefined }), {
    description: "A private application record", mimeType: "application/json",
  }, async (uri, { id }) => {
    // Resource failures must not leak adapter messages or credentials.
    try { return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await service.get(id)) }] }; }
    catch { throw new Error("Record unavailable."); }
  });
  if (history) {
    server.registerTool("conversations_events", {
      description: "Read versioned conversation stream projections, including finalized text and run boundaries. These may contain retried attempts and may lag Eve; they are not canonical model history. Empty results do not prove a conversation was empty.",
      inputSchema: z.object({ operationId,options: projectionOptions.optional() }).strict(),annotations: { readOnlyHint: true,openWorldHint: false },
    }, input => result(() => history.events(input.operationId,input.options)));
    server.registerTool("conversations_list", {
      description: "List the signed-in user's private conversation metadata. Returns nextCursor; archive state only organizes history. This does not read transcripts or start a run.",
      inputSchema: historyOptions, annotations: { readOnlyHint: true, openWorldHint: false },
    }, input => result(() => history.list(input)));
    server.registerTool("conversations_get", {
      description: "Read one owned conversation's title, archive state, revision and ownership status. operationId is the app locator, not a runtime session ID.",
      inputSchema: { operationId }, annotations: { readOnlyHint: true, openWorldHint: false },
    }, input => result(() => history.get(input.operationId)));
    server.registerTool("conversations_update", {
      description: "Rename, archive or restore an owned conversation at its current revision. Refresh on conflict or uncertain outcomes. Archiving does not delete messages, cancel work or revoke access.",
      inputSchema: z.object({ operationId, patch: historyPatch }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    }, input => result(() => history.update(input.operationId,input.patch)));
    server.registerResource("conversation", new ResourceTemplate("conversations:///{operationId}",{ list: undefined }), {
      description: "Private conversation metadata; excludes transcripts and runtime identifiers", mimeType: "application/json",
    }, async (uri,params) => {
      try { return { contents: [{ uri: uri.href,mimeType: "application/json",text: JSON.stringify(await history.get(params.operationId)) }] }; }
      catch { throw new Error("Conversation unavailable."); }
    });
  }
  if (artifacts) {
    server.registerTool("artifacts_list",{
      description: "List private plain-text artifacts created after the owner's approval. Returns a cursor and content; never starts model work.",
      inputSchema: artifactOptions,annotations: { readOnlyHint: true,openWorldHint: false },
    },input => result(() => artifacts.list(input)));
    server.registerTool("artifacts_get",{
      description: "Read one owned private artifact by its UUID.",inputSchema: { id: z.uuid() },annotations: { readOnlyHint: true,openWorldHint: false },
    },({ id }) => result(() => artifacts.get(id)));
    server.registerTool("artifacts_delete",{
      description: "Erase the stored title, content and input hash of one owned artifact. The call receipt remains to prevent replay; source chat and backups have separate retention.",
      inputSchema: { id: z.uuid() },annotations: { destructiveHint: true,idempotentHint: false,openWorldHint: false },
    },({ id }) => result(async () => { await artifacts.delete(id);return { deleted: true }; }));
    server.registerResource("artifact",new ResourceTemplate("artifacts:///{id}",{ list: undefined }),{
      description: "Private approved plain-text artifact",mimeType: "application/json",
    },async (uri,{ id }) => {
      try { return { contents: [{ uri: uri.href,mimeType: "application/json",text: JSON.stringify(await artifacts.get(id)) }] }; }
      catch { throw new Error("Artifact unavailable."); }
    });
  }
  if (usage) {
    server.registerTool("usage_get",{
      description: "Read the signed-in user's current UTC-day AI budget usage and configured daily limit. Unknown costs charge the estimate; these are not provider invoice totals.",
      inputSchema: z.object({}).strict(),annotations: { readOnlyHint: true,openWorldHint: false },
    },() => result(() => usage.get()));
    server.registerResource("usage","usage:///current",{
      description: "Private current AI budget usage",mimeType: "application/json",
    },async uri => {
      try { return { contents: [{ uri: uri.href,mimeType: "application/json",text: JSON.stringify(await usage.get()) }] }; }
      catch { throw new Error("Usage unavailable."); }
    });
  }
  if (uploads) {
    server.registerTool("uploads_list",{
      description: "List the caller's active private upload metadata. Files remain quarantined and cannot be downloaded or attached to the agent.",
      inputSchema: z.object({}).strict(),annotations: { readOnlyHint: true,openWorldHint: false },
    },() => result(() => uploads.list()));
    server.registerTool("uploads_usage",{
      description: "Read the caller's reserved file and byte quota, including pending and deleting uploads.",
      inputSchema: z.object({}).strict(),annotations: { readOnlyHint: true,openWorldHint: false },
    },() => result(() => uploads.usage()));
    server.registerTool("uploads_get",{
      description: "Read one owned upload's metadata and quarantine state; never returns file bytes.",
      inputSchema: { id: z.uuid() },annotations: { readOnlyHint: true,openWorldHint: false },
    },({ id }) => result(() => uploads.get(id)));
    server.registerTool("uploads_delete",{
      description: "Delete one owned quarantined upload and its private object. Does not erase backups.",
      inputSchema: { id: z.uuid() },annotations: { destructiveHint: true,idempotentHint: false,openWorldHint: false },
    },({ id }) => result(async () => { await uploads.delete(id);return { deleted: true }; }));
    server.registerResource("upload",new ResourceTemplate("uploads:///{id}",{ list: undefined }),{
      description: "Private upload metadata; never file bytes",mimeType: "application/json",
    },async (uri,{ id }) => {
      try { return { contents: [{ uri: uri.href,mimeType: "application/json",text: JSON.stringify(await uploads.get(typeof id === "string" ? id : "")) }] }; }
      catch { throw new Error("Upload unavailable."); }
    });
  }
  return server;
}

export function mcpHandler(repository: () => Promise<RecordRepository> = getRepository, accessStore: () => Promise<SessionAccessStore> = getSessionAccessStore,budgetStore: () => Promise<BudgetStore> = getBudgetStore,
  uploadCatalog: () => Promise<UploadCatalog> = getUploadCatalog) {
  return (request: Request) => handle(request, async () => {
    const principal = await authenticate(request);
    const parsedBody = await readJson(request);
    // Credential provenance is assigned by authenticate, never by claims/metadata
    // supplied by callers or by an API key configured with the same owner string.
    const settings = principal.credentialType === "user" ? chatSettings() : null;
    const ownedStore = settings ? await accessStore() : undefined;
    const owner = { tenant: principal.tenant,subject: principal.subject };
    const history = ownedStore ? new ConversationHistoryService(ownedStore,owner) : undefined;
    const artifacts = ownedStore ? new ArtifactService(ownedStore,owner) : undefined;
    const usage = settings ? new UsageService(budgetStore,owner,settings.budget.policy.dailyMicros) : undefined;
    const uploads = process.env.UPLOAD_STORAGE_PROVIDER ? new UploadService(await uploadCatalog(),createUploadObjects,principal) : undefined;
    const server = createMcpServer(new RecordService(await repository(), principal), history, artifacts, usage,uploads);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try { return await transport.handleRequest(request, { parsedBody }); }
    finally { await server.close(); }
  });
}
