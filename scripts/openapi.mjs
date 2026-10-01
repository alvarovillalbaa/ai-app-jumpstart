import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "public/openapi.json");
const uuid = { type: "string", format: "uuid" };
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const query = (name, schema, description) => ({ name, in: "query", required: false, schema, description });
const header = (name, schema, description) => ({ name, in: "header", required: true, schema, description });
const jsonBody = schema => ({ required: true, content: { "application/json": { schema } } });
const emptyBody = jsonBody({ type: "object", additionalProperties: false });
const limit = (maximum, fallback) => query("limit", { type: "integer", minimum: 1, maximum, default: fallback }, "Page size");
const cursor = query("cursor", { type: "string" }, "Opaque cursor from the previous page");
const paths = {};

function add(path, method, operationId, summary, options = {}) {
  if (paths[path]?.[method]) throw new Error(`Duplicate OpenAPI operation: ${method} ${path}`);
  const { status = 200, schema, type = "application/json", body, params = [],
    auth = "registered user", details = "", extra = {} } = options;
  if (status !== 204 && !schema) throw new Error(`Missing OpenAPI success schema: ${method} ${path}`);
  const tag = path.split("/")[3];
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => ({
    name, in: "path", required: true, schema: uuid,
  }));
  const success = { description: summary };
  if (status !== 204) success.content = { [type]: { schema } };
  const responses = { [status]: success, ...extra, default: { $ref: "#/components/responses/ApiError" } };
  const operation = {
    tags: [tag], operationId, summary,
    description: details || `${summary}. See docs/data-access.md for ownership and feature policy.`,
    security: [{ bearerAuth: [] }], "x-jumpstart-credential": auth,
    parameters: [...pathParams, ...params], responses,
  };
  if (body) operation.requestBody = body;
  (paths[path] ??= {})[method] = operation;
}

const recordAuth = "registered user or API key with the stated records scope";
const uploadAuth = "registered user or API key with the stated uploads scope";
const accountAuth = "current registered-user access token; record API keys are denied";

add("/api/v1/records", "get", "listRecords", "List owner records", {
  schema: ref("RecordPage"), auth: `${recordAuth}: records:read`,
  params: [limit(100, 25), query("after", uuid, "Last record UUID from the prior page")],
});
add("/api/v1/records", "post", "createRecord", "Create an owner record", {
  status: 201, schema: ref("Record"), body: jsonBody(ref("RecordInput")),
  params: [{ name: "Idempotency-Key", in: "header", required: false, schema: uuid,
    description: "Optional owner-scoped creation key; a matching replay returns 200" }],
  auth: `${recordAuth}: records:write`,
  extra: { 200: { description: "Matching keyed replay", content: { "application/json": { schema: ref("Record") } } } },
});
add("/api/v1/records/{id}", "get", "getRecord", "Read an owner record", {
  schema: ref("Record"), auth: `${recordAuth}: records:read`,
});
add("/api/v1/records/{id}", "patch", "updateRecord", "Replace a record at its current revision", {
  schema: ref("Record"), body: jsonBody(ref("RecordUpdate")), auth: `${recordAuth}: records:write`,
});
add("/api/v1/records/{id}", "delete", "deleteRecord", "Delete a record at its current revision", {
  status: 204, params: [{ ...query("revision", { type: "integer", minimum: 1 }, "Current record revision"), required: true }],
  auth: `${recordAuth}: records:write`,
});
add("/api/v1/records/creation/{key}", "get", "getRecordCreation", "Recover keyed creation status", {
  schema: ref("RecordCreationStatus"), auth: `${recordAuth}: records:read`,
});

add("/api/v1/account/profile", "get", "getAccountProfile", "Read selected account profile fields", {
  schema: ref("AccountProfile"), auth: accountAuth,
  details: "Returns selected Supabase Auth profile fields, excluding credentials, sessions and MFA factors. See docs/data-access.md.",
});
add("/api/v1/account/preferences", "get", "getAccountPreferences", "Read account preferences", {
  schema: ref("AccountPreferences"), auth: accountAuth,
});
add("/api/v1/account/preferences", "patch", "updateAccountPreferences", "Update account preferences by revision", {
  schema: ref("AccountPreferences"), body: jsonBody(ref("AccountPreferencesPatch")), auth: accountAuth,
});
add("/api/v1/account/request-limit", "get", "getAccountRequestLimit", "Read the current admitted-request window", {
  schema: ref("RequestLimitSnapshot"), auth: accountAuth,
  details: "Returns the latest stored owner window, not request history. The read itself consumes admission when the limiter is enabled.",
});

add("/api/v1/conversations", "get", "listConversations", "List owner conversation metadata", {
  schema: ref("ConversationPage"), auth: accountAuth,
  params: [limit(50, 20), query("archived", { type: "boolean", default: false }, "Include archived instead of active conversations"), cursor],
});
add("/api/v1/conversations", "post", "createConversation", "Start an owned agent conversation", {
  status: 202, schema: ref("ConversationStarting"), body: jsonBody(ref("ConversationCreate")), auth: `${accountAuth}; enabled account chat required`,
  details: "A 202 result is still starting; recover by operation ID without redispatching. A previously bound operation returns 200. See docs/account-chat.md.",
  extra: { 200: { description: "Existing active operation", content: { "application/json": { schema: ref("ConversationActive") } } } },
});
add("/api/v1/conversations/{operationId}", "get", "getConversationStart", "Read conversation creation status", {
  schema: ref("ConversationCreation"), auth: `${accountAuth}; enabled account chat required`,
});
add("/api/v1/conversations/{operationId}", "patch", "updateConversation", "Edit conversation metadata by revision", {
  schema: ref("ConversationSummary"), body: jsonBody(ref("ConversationPatch")), auth: accountAuth,
});
add("/api/v1/conversations/{operationId}/metadata", "get", "getConversationMetadata", "Read conversation metadata", {
  schema: ref("ConversationSummary"), auth: accountAuth,
});
add("/api/v1/conversations/{operationId}/runs", "get", "listConversationRuns", "List saved run summaries", {
  schema: ref("RunPage"), auth: accountAuth,
  params: [limit(50, 20), query("after", { type: "integer", minimum: 0 }, "Last run index")],
});
add("/api/v1/conversations/{operationId}/events", "get", "listConversationEvents", "List saved stream projections", {
  schema: ref("ProjectionPage"), auth: accountAuth,
  params: [limit(50, 20), query("after", { type: "integer", minimum: 0 }, "Last ingestion index")],
});
add("/api/v1/conversations/{operationId}/source-events", "get", "listConversationSourceEvents", "Read retained Eve source events", {
  schema: ref("SourceEventPage"), auth: `${accountAuth}; enabled account chat required`,
  params: [query("startIndex", { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 250, default: 0 }, "Absolute source index"), limit(50, 20)],
  details: "Absolute source order includes interrupted attempts and is not canonical model history. See docs/conversation-projections.md.",
});
add("/api/v1/conversations/{operationId}/reconcile", "post", "reconcileConversation", "Reconcile saved projections from Eve", {
  schema: ref("ReconcileResult"), auth: `${accountAuth}; enabled account chat required`, body: jsonBody({ type: "object", additionalProperties: false,
    properties: { resume: { type: "boolean" }, startIndex: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 250 } },
    not: { required: ["resume", "startIndex"], properties: { resume: { const: true } } } }),
});
add("/api/v1/conversations/{operationId}/cancel-start", "post", "cancelConversationStart", "Cancel an unbound conversation start", {
  schema: ref("CancelledStart"), auth: `${accountAuth}; enabled account chat required`,
  details: "Only an unbound start can settle at verified zero. Active or ambiguous work is not refunded. See docs/account-chat.md.",
});

add("/api/v1/artifacts", "get", "listArtifacts", "List private saved artifacts", {
  schema: ref("ArtifactPage"), auth: accountAuth, params: [limit(50, 20), cursor],
});
add("/api/v1/artifacts/{id}", "get", "getArtifact", "Read a private saved artifact", {
  schema: ref("Artifact"), auth: accountAuth,
});
add("/api/v1/artifacts/{id}", "patch", "updateArtifact", "Edit a private artifact by revision", {
  schema: ref("Artifact"), auth: accountAuth, body: jsonBody(ref("ArtifactPatch")),
});
add("/api/v1/artifacts/{id}", "delete", "deleteArtifact", "Delete an artifact and its versions", {
  status: 204, auth: accountAuth,
});
add("/api/v1/artifacts/{id}/versions", "get", "listArtifactVersions", "List immutable artifact versions", {
  schema: ref("ArtifactVersionPage"), auth: accountAuth,
  params: [limit(50, 20), query("before", { type: "integer", minimum: 1 }, "Revision cursor")],
});
add("/api/v1/artifacts/{id}/download", "get", "downloadArtifact", "Download artifact text", {
  auth: accountAuth, type: "text/plain", schema: { type: "string" },
});

add("/api/v1/uploads", "get", "listUploads", "List private upload metadata and usage", {
  schema: ref("UploadPage"), auth: `${uploadAuth}: uploads:read`,
});
add("/api/v1/uploads", "post", "createUpload", "Create a quarantined private upload", {
  status: 201, schema: ref("UploadEntry"), auth: `${uploadAuth}: uploads:write`,
  params: [header("x-upload-name", { type: "string", maxLength: 512 }, "Percent-encoded filename"),
    header("x-upload-media-type", { type: "string" }, "Declared media type")],
  body: { required: true, description: "Raw nonempty bytes, at most 4 MiB", content: {
    "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
});
add("/api/v1/uploads/{id}", "get", "getUpload", "Read private upload metadata", {
  schema: ref("UploadEntry"), auth: `${uploadAuth}: uploads:read`,
});
add("/api/v1/uploads/{id}", "delete", "deleteUpload", "Delete a private upload and object", {
  status: 204, auth: `${uploadAuth}: uploads:write`,
});
add("/api/v1/uploads/{id}/review", "get", "getUploadReview", "Read the upload review receipt", {
  schema: ref("UploadReview"), auth: `${uploadAuth}: uploads:read`,
});
add("/api/v1/uploads/{id}/review", "put", "updateUploadReview", "Approve or revoke an upload review", {
  schema: ref("UploadReview"), auth: `${uploadAuth}: uploads:write; approval also needs uploads:download`,
  body: jsonBody(ref("UploadReviewDecision")),
});
add("/api/v1/uploads/{id}/scan", "post", "scanUpload", "Run a fresh upload scan", {
  schema: ref("UploadEntry"), auth: `${uploadAuth}: uploads:download`, body: emptyBody,
});
add("/api/v1/uploads/{id}/text", "get", "extractUploadText", "Read approved bounded UTF-8 text", {
  schema: ref("ExtractedUploadText"), auth: `${uploadAuth}: uploads:download`,
});
add("/api/v1/uploads/{id}/download", "get", "downloadUpload", "Download fresh-scanned private bytes", {
  auth: `${uploadAuth}: uploads:download`, type: "application/octet-stream",
  schema: { type: "string", format: "binary" },
  params: [query("grant", { type: "string" }, "Optional 60-second owner-bound download grant")],
});
add("/api/v1/uploads/{id}/download-link", "post", "createUploadDownloadLink", "Create a short-lived owner download link", {
  schema: ref("UploadDownloadLink"), auth: `${uploadAuth}: uploads:download`, body: emptyBody,
});

add("/api/v1/usage", "get", "getUsage", "Read the current owner budget view", {
  schema: ref("UsageView"), auth: accountAuth,
});
add("/api/v1/usage/reservations", "get", "listUsageReservations", "List owner budget reservations", {
  schema: ref("LedgerPage"), auth: accountAuth, params: [limit(100, 50), cursor],
});
add("/api/v1/usage/corrections", "get", "listUsageCorrections", "List owner-visible budget corrections", {
  schema: ref("CorrectionPage"), auth: accountAuth, params: [limit(100, 50), cursor],
});

const string = (maximum) => ({ type: "string", maxLength: maximum });
const timestamp = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER,
  description: "Unix epoch milliseconds" };
const sha256 = { type: "string", pattern: "^[a-f0-9]{64}$" };
const micros = { type: "integer", minimum: 0, maximum: 1_000_000_000_000 };
const pageCursor = { type: ["string", "null"], pattern: "^[0-9]{1,16}\\.[a-f0-9-]{36}$" };
const sourceIndex = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const nullableSourceIndex = { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const projectionProperties = { schemaVersion: { const: 1 },
  eventId: { type: "string", pattern: "^evt_[0-9A-HJKMNP-TV-Z]{26}$" },
  at: { type: "string", format: "date-time" }, turnId: { type: "string", minLength: 1, maxLength: 512 },
  sequence: sourceIndex, stepIndex: { type: "integer", minimum: 0 }, payload: ref("ProjectionPayload") };
const projectionRequired = ["schemaVersion", "eventId", "at", "turnId", "sequence", "payload"];
const recordInput = { type: "object", additionalProperties: false,
  required: ["title", "content"], properties: { title: { ...string(200), minLength: 1 }, content: string(32000) } };
const components = {
  securitySchemes: { bearerAuth: { type: "http", scheme: "bearer",
    description: "Current registered-user token or a scoped application API key where the operation permits it" } },
  responses: { ApiError: { description: "Application error; transport/protocol failures may differ",
    content: { "application/json": { schema: ref("ApiError") } } } },
  schemas: {
    ApiError: { type: "object", additionalProperties: false, required: ["error"], properties: {
      error: { type: "object", additionalProperties: false, required: ["code", "message", "requestId"],
        properties: { code: { type: "string" }, message: { type: "string" }, requestId: uuid } },
    } },
    RecordInput: recordInput,
    RecordUpdate: { ...recordInput, required: ["title", "content", "revision"],
      properties: { ...recordInput.properties, revision: { type: "integer", minimum: 1 } } },
    Record: { ...recordInput, required: ["id", "title", "content", "revision", "createdAt", "updatedAt"],
      properties: { ...recordInput.properties, id: uuid, revision: { type: "integer", minimum: 1 },
        createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" } } },
    RecordPage: { type: "object", additionalProperties: false, required: ["items", "nextCursor"],
      properties: { items: { type: "array", items: ref("Record") }, nextCursor: { type: ["string", "null"], format: "uuid" } } },
    RecordCreationStatus: { oneOf: [
      { type: "object", additionalProperties: false, required: ["status", "record"],
        properties: { status: { const: "created" }, record: ref("Record") } },
      { type: "object", additionalProperties: false, required: ["status", "id"],
        properties: { status: { const: "deleted" }, id: uuid } },
    ] },
    AccountPreferences: { type: "object", additionalProperties: false,
      required: ["schemaVersion", "revision", "updatedAt", "theme", "soundEnabled", "soundVolume"],
      properties: { schemaVersion: { const: 1 }, revision: { type: "integer", minimum: 0 },
        updatedAt: { type: ["string", "null"], format: "date-time" },
        theme: { enum: ["system", "light", "dark"] }, soundEnabled: { type: "boolean" },
        soundVolume: { type: "number", minimum: 0, maximum: 1 } } },
    AccountPreferencesPatch: { type: "object", additionalProperties: false, required: ["revision"],
      properties: { revision: { type: "integer", minimum: 0 },
        theme: { enum: ["system", "light", "dark"] }, soundEnabled: { type: "boolean" },
        soundVolume: { type: "number", minimum: 0, maximum: 1 } },
      anyOf: [{ required: ["theme"] }, { required: ["soundEnabled"] }, { required: ["soundVolume"] }] },
    AccountProfile: { type: "object", additionalProperties: false,
      description: "Selected Supabase Auth fields; provider metadata may contain private user-supplied values.",
      required: ["id", "email", "phone", "createdAt", "updatedAt", "lastSignInAt", "emailConfirmedAt", "phoneConfirmedAt", "providers", "userMetadata"],
      properties: { id: uuid, email: { type: ["string", "null"] }, phone: { type: ["string", "null"] },
        createdAt: { type: "string", minLength: 1 }, updatedAt: { type: ["string", "null"] },
        lastSignInAt: { type: ["string", "null"] }, emailConfirmedAt: { type: ["string", "null"] },
        phoneConfirmedAt: { type: ["string", "null"] },
        providers: { type: "array", maxItems: 20, items: { type: "string" } },
        userMetadata: { type: "object", additionalProperties: true } } },
    RequestLimitSnapshot: { type: "object", additionalProperties: false, required: ["snapshot"],
      properties: { snapshot: { oneOf: [{ type: "null" }, { type: "object", additionalProperties: false,
        required: ["windowStartAt", "admitted"], properties: { windowStartAt: { type: "string", format: "date-time" },
          admitted: { type: "integer", minimum: 1, maximum: 10000 } } }] } } },
    ConversationCreate: { oneOf: [
      { type: "object", additionalProperties: false, required: ["operationId", "message"],
        properties: { operationId: uuid, message: { type: "string", minLength: 1, maxLength: 32000 } } },
      { type: "object", additionalProperties: false, required: ["operationId", "message", "mode"],
        properties: { operationId: uuid, message: { type: "string", minLength: 1, maxLength: 32000 },
          mode: { const: "structured-record" } } },
    ] },
    ConversationStarting: { type: "object", additionalProperties: false,
      required: ["conversationId", "operationId", "status", "sessionId"],
      properties: { conversationId: uuid, operationId: uuid, status: { const: "starting" }, sessionId: { type: "null" } } },
    ConversationActive: { type: "object", additionalProperties: false,
      required: ["conversationId", "operationId", "status", "sessionId"],
      properties: { conversationId: uuid, operationId: uuid, status: { const: "active" },
        sessionId: { type: "string", minLength: 1, maxLength: 512 } } },
    ConversationCreation: { oneOf: [ref("ConversationStarting"), ref("ConversationActive")] },
    CancelledStart: { type: "object", additionalProperties: false,
      required: ["conversationId", "operationId", "status"],
      properties: { conversationId: uuid, operationId: uuid, status: { const: "cancelled" } } },
    ConversationPatch: { type: "object", additionalProperties: false, required: ["revision"],
      properties: { revision: { type: "integer", minimum: 1 }, title: { type: "string", minLength: 1, maxLength: 120 },
        archived: { type: "boolean" } }, anyOf: [{ required: ["title"] }, { required: ["archived"] }] },
    ConversationSummary: { type: "object", additionalProperties: false,
      required: ["id", "operationId", "title", "createdAt", "archived", "revision", "status"],
      properties: { id: uuid, operationId: uuid, title: { type: "string", minLength: 1, maxLength: 120 },
        createdAt: timestamp, archived: { type: "boolean" }, revision: { type: "integer", minimum: 1 },
        status: { enum: ["starting", "active", "revoked"] } } },
    ConversationPage: { type: "object", additionalProperties: false, required: ["items", "nextCursor"],
      properties: { items: { type: "array", items: ref("ConversationSummary") }, nextCursor: pageCursor } },
    RunView: { type: "object", additionalProperties: false,
      required: ["turnId", "firstIndex", "state", "startedAt", "lastBoundaryAt", "lastSourceIndex", "code", "boundarySourceIndex", "unindexedFacts", "models", "boundaryCount", "unindexedBoundaries", "coverage"],
      properties: { turnId: { type: "string", minLength: 1, maxLength: 512 }, firstIndex: { type: "integer", minimum: 1 },
        state: { enum: ["unverified", "running", "completed", "failed", "cancelled"] },
        startedAt: { type: ["string", "null"], format: "date-time" },
        lastBoundaryAt: { type: ["string", "null"], format: "date-time" },
        lastSourceIndex: nullableSourceIndex, code: { type: ["string", "null"], maxLength: 100 },
        boundarySourceIndex: nullableSourceIndex, unindexedFacts: { type: "integer", minimum: 0 },
        models: { type: "array", items: { type: "string", maxLength: 200 } },
        boundaryCount: { type: "integer", minimum: 0 }, unindexedBoundaries: { type: "integer", minimum: 0 },
        coverage: { type: "object", additionalProperties: false, required: ["checkpoint", "indexComplete"],
          properties: { checkpoint: sourceIndex, indexComplete: { type: "boolean" } } } } },
    RunPage: { type: "object", additionalProperties: false,
      required: ["schemaVersion", "source", "items", "nextCursor"],
      properties: { schemaVersion: { const: 1 }, source: { const: "eve-run-boundaries" },
        items: { type: "array", items: ref("RunView") },
        nextCursor: { type: ["integer", "null"], minimum: 1 } } },
    ProjectionPayload: { oneOf: [
      { type: "object", additionalProperties: false, required: ["kind", "modelId"],
        properties: { kind: { const: "model" }, modelId: { type: "string", minLength: 1, maxLength: 200 } } },
      { type: "object", additionalProperties: false, required: ["kind", "state"],
        properties: { kind: { const: "run" }, state: { enum: ["running", "completed", "failed", "cancelled"] },
          code: { type: "string", maxLength: 100 } } },
      { type: "object", additionalProperties: false, required: ["kind", "role", "parts"],
        properties: { kind: { const: "message" }, role: { enum: ["user", "assistant"] },
          parts: { type: "array", items: { oneOf: [
            { type: "object", additionalProperties: false, required: ["type", "text"],
              properties: { type: { const: "text" }, text: { type: "string" } } },
            { type: "object", additionalProperties: false, required: ["type", "mediaType"],
              properties: { type: { const: "file" }, filename: { type: "string" },
                mediaType: { type: "string" }, size: { type: "number", minimum: 0 } } },
          ] } }, finishReason: { type: "string", maxLength: 100 } } },
      { type: "object", additionalProperties: false, required: ["kind", "phase", "value"],
        properties: { kind: { const: "tool" }, phase: { enum: ["requested", "result"] }, value: {} } },
      { type: "object", additionalProperties: false, required: ["kind", "value"],
        properties: { kind: { const: "result" }, value: {} } },
      { type: "object", additionalProperties: false, required: ["kind", "action"],
        properties: { kind: { const: "context" }, action: { enum: ["cleared", "compacted"] } } },
      { type: "object", additionalProperties: false, required: ["kind", "eventType", "reason"],
        properties: { kind: { const: "omitted" }, eventType: { type: "string", maxLength: 100 }, reason: { const: "size_limit" } } },
    ] },
    ProjectionPage: { type: "object", additionalProperties: false,
      required: ["schemaVersion", "source", "items", "nextCursor"],
      properties: { schemaVersion: { const: 1 }, source: { const: "eve-stream" },
        items: { type: "array", items: { type: "object", additionalProperties: false,
          required: [...projectionRequired, "ingestionIndex"],
          properties: { ...projectionProperties, ingestionIndex: { type: "integer", minimum: 1 },
            sourceIndex } } }, nextCursor: { type: ["integer", "null"], minimum: 1 } } },
    SourceEventPage: { type: "object", additionalProperties: false,
      required: ["schemaVersion", "source", "items", "scanned", "nextIndex", "complete"],
      properties: { schemaVersion: { const: 1 }, source: { const: "eve-durable-stream" },
        items: { type: "array", items: { type: "object", additionalProperties: false,
          required: [...projectionRequired, "sourceIndex"], properties: { ...projectionProperties, sourceIndex } } },
        scanned: sourceIndex, nextIndex: sourceIndex, complete: { type: "boolean" } } },
    ReconcileResult: { type: "object", additionalProperties: false,
      required: ["processed", "inserted", "duplicates", "nextIndex", "complete", "checkpoint"],
      properties: { processed: { type: "integer", minimum: 0, maximum: 250 },
        inserted: { type: "integer", minimum: 0, maximum: 250 },
        duplicates: { type: "integer", minimum: 0, maximum: 250 },
        nextIndex: sourceIndex, complete: { type: "boolean" }, checkpoint: sourceIndex } },
    ArtifactPatch: { type: "object", additionalProperties: false,
      description: "Revision-checked artifact title/content replacement; see docs/approved-artifacts.md.",
      required: ["revision", "title", "content"], properties: { revision: { type: "integer", minimum: 1, maximum: 100 },
        title: { type: "string", minLength: 1, maxLength: 120 }, content: { type: "string", minLength: 1, maxLength: 32000 } } },
    Artifact: { type: "object", additionalProperties: false,
      required: ["id", "operationId", "sourceSessionId", "sourceCallId", "title", "content", "mediaType", "createdAt", "revision", "updatedAt"],
      properties: { id: uuid, operationId: uuid, sourceSessionId: { type: "string", minLength: 1, maxLength: 512 },
        sourceCallId: { type: "string", minLength: 1, maxLength: 512 },
        title: { type: "string", minLength: 1, maxLength: 120 }, content: { type: "string", minLength: 1, maxLength: 32000 },
        mediaType: { const: "text/plain" }, createdAt: timestamp, revision: { type: "integer", minimum: 1, maximum: 100 },
        updatedAt: timestamp } },
    ArtifactPage: { type: "object", additionalProperties: false, required: ["items", "nextCursor"],
      properties: { items: { type: "array", items: ref("Artifact") }, nextCursor: pageCursor } },
    ArtifactVersionPage: { type: "object", additionalProperties: false, required: ["items", "nextBefore"],
      properties: { items: { type: "array", items: ref("Artifact") }, nextBefore: { type: ["integer", "null"], minimum: 1, maximum: 100 } } },
    UploadScan: { oneOf: [
      { type: "object", additionalProperties: false, required: ["sha256", "checkedAt", "policyVersion", "status"],
        properties: { sha256, checkedAt: timestamp, policyVersion: { const: 1 }, status: { const: "clean" } } },
      { type: "object", additionalProperties: false, required: ["sha256", "checkedAt", "policyVersion", "status", "reason"],
        properties: { sha256, checkedAt: timestamp, policyVersion: { const: 1 }, status: { const: "rejected" },
          reason: { enum: ["malware", "integrity"] } } },
    ] },
    UploadEntry: { type: "object", additionalProperties: false,
      required: ["id", "name", "mediaType", "size", "sha256", "createdAt", "state"],
      properties: { id: uuid, name: { type: "string", minLength: 1, maxLength: 120 },
        mediaType: { enum: ["text/plain", "image/png", "image/jpeg", "application/pdf"] },
        size: { type: "integer", minimum: 1, maximum: 5 * 1024 * 1024 }, sha256,
        createdAt: timestamp, state: { enum: ["pending", "quarantined", "clean", "rejected", "deleting", "deleted"] },
        scan: ref("UploadScan") } },
    UploadPage: { type: "object", additionalProperties: false, required: ["items", "usage"],
      properties: { items: { type: "array", maxItems: 1000, items: ref("UploadEntry") },
        usage: { type: "object", additionalProperties: false, required: ["files", "bytes"],
          properties: { files: { type: "integer", minimum: 0 }, bytes: { type: "integer", minimum: 0 } } } } },
    UploadReviewDecision: { type: "object", additionalProperties: false,
      required: ["sha256", "revision", "approved"], properties: {
        sha256, revision: { type: "integer", minimum: 0, maximum: 2_147_483_646 },
        approved: { type: "boolean" } } },
    UploadReview: { type: "object", additionalProperties: false,
      required: ["id", "sha256", "revision", "status", "approvedAt", "checkedAt", "policyVersion"],
      properties: { id: uuid, sha256, revision: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
        status: { enum: ["unreviewed", "approved", "revoked"] },
        approvedAt: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        checkedAt: { type: ["integer", "null"], minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        policyVersion: { const: 1 } } },
    ExtractedUploadText: { type: "object", additionalProperties: false,
      required: ["id", "sha256", "reviewRevision", "mediaType", "text", "trust"],
      properties: { id: uuid, sha256, reviewRevision: { type: "integer", minimum: 0, maximum: 2_147_483_647 },
        mediaType: { const: "text/plain" }, text: { type: "string", minLength: 1, maxLength: 32 * 1024 },
        trust: { const: "untrusted-user-content" } } },
    UploadDownloadLink: { type: "object", additionalProperties: false, required: ["url", "expiresAt"],
      properties: { url: { type: "string", maxLength: 300,
        description: "Owner-bound relative application URL; redemption still requires current credentials and a fresh scan." },
        expiresAt: timestamp } },
    UsageView: { type: "object", additionalProperties: false,
      required: ["day", "reservedMicros", "chargedMicros", "active", "recent", "unknownCosts", "dailyLimitMicros"],
      properties: { day: { type: "integer", minimum: 0 }, reservedMicros: { type: "integer", minimum: 0 },
        chargedMicros: { type: "integer", minimum: 0 }, active: { type: "integer", minimum: 0 },
        recent: { type: "integer", minimum: 0 }, unknownCosts: { type: "integer", minimum: 0 },
        dailyLimitMicros: { type: ["integer", "null"], minimum: 1, maximum: 1_000_000_000_000 } } },
    LedgerEntry: { type: "object", additionalProperties: false,
      required: ["operationId", "createdAt", "day", "policyId", "estimateMicros", "status", "actualMicros"],
      properties: { operationId: uuid, createdAt: { ...timestamp, minimum: 1 }, day: { type: "integer", minimum: 0 },
        policyId: { type: "string", minLength: 1, maxLength: 100 }, estimateMicros: { ...micros, minimum: 1 },
        status: { enum: ["reserved", "settled"] }, actualMicros: { type: ["integer", "null"], minimum: 0, maximum: 1_000_000_000_000 } } },
    LedgerPage: { type: "object", additionalProperties: false, required: ["items", "nextCursor"],
      properties: { items: { type: "array", items: ref("LedgerEntry") }, nextCursor: pageCursor } },
    CorrectionEntry: { type: "object", additionalProperties: false,
      required: ["correctionId", "operationId", "previousActualMicros", "correctedActualMicros", "at"],
      properties: { correctionId: uuid, operationId: uuid,
        previousActualMicros: { type: ["integer", "null"], minimum: 0, maximum: 1_000_000_000_000 },
        correctedActualMicros: micros, at: { ...timestamp, minimum: 1 } } },
    CorrectionPage: { type: "object", additionalProperties: false, required: ["items", "nextCursor"],
      properties: { items: { type: "array", items: ref("CorrectionEntry") }, nextCursor: pageCursor } },
  },
};

const spec = { openapi: "3.1.0", info: { title: "AI app jumpstart REST API", version: "1.0.0",
  description: "Owner-scoped application API. Feature-gated operations need their configured services. CLI and MCP use the same application services; see docs/data-access.md for retention, provider and authorization details." },
servers: [{ url: "/", description: "The application origin serving this document" }],
security: [{ bearerAuth: [] }], tags: ["records", "account", "conversations", "artifacts", "uploads", "usage"].map(name => ({ name })),
paths, components };

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path));
    else if (entry.name === "route.ts") result.push(path);
  }
  return result;
}

async function checkRouteCoverage() {
  const authored = new Set();
  for (const file of await files(join(root, "app/api/v1"))) {
    const path = "/api/v1/" + relative(join(root, "app/api/v1"), file)
      .replace(/\/route\.ts$/, "").replace(/\[([^\]]+)\]/g, "{$1}");
    const source = await readFile(file, "utf8");
    const methods = [...source.matchAll(/export\s+(?:(?:async\s+)?function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)];
    if (!methods.length) throw new Error(`No HTTP methods found in ${file}`);
    for (const [, method] of methods) authored.add(`${method.toLowerCase()} ${path}`);
  }
  const described = new Set(Object.entries(paths).flatMap(([path, methods]) =>
    Object.keys(methods).map(method => `${method} ${path}`)));
  const missing = [...authored].filter(item => !described.has(item));
  const extra = [...described].filter(item => !authored.has(item));
  if (missing.length || extra.length) throw new Error(`OpenAPI route drift: missing ${missing.sort().join(", ") || "none"}; extra ${extra.sort().join(", ") || "none"}`);
  const ids = Object.values(paths).flatMap(methods => Object.values(methods).map(operation => operation.operationId));
  if (new Set(ids).size !== ids.length) throw new Error("OpenAPI operation IDs must be unique.");
  return ids.length;
}

function checkDocument() {
  for (const [path, methods] of Object.entries(paths)) {
    const expectedParams = [...path.matchAll(/\{([^}]+)\}/g)].map(([, name]) => name).sort();
    for (const [method, operation] of Object.entries(methods)) {
      if (!operation.summary || !operation.responses.default || !operation.responses[200] &&
          !operation.responses[201] && !operation.responses[202] && !operation.responses[204])
        throw new Error(`Incomplete OpenAPI operation: ${method} ${path}`);
      const actualParams = operation.parameters.filter(item => item.in === "path" && item.required)
        .map(item => item.name).sort();
      if (JSON.stringify(actualParams) !== JSON.stringify(expectedParams))
        throw new Error(`OpenAPI path parameters drifted: ${method} ${path}`);
    }
  }
  function walk(value) {
    if (!value || typeof value !== "object") return;
    if (typeof value.$ref === "string") {
      if (!value.$ref.startsWith("#/")) throw new Error(`External OpenAPI reference: ${value.$ref}`);
      const found = value.$ref.slice(2).split("/").reduce((current, key) => current?.[key], spec);
      if (!found) throw new Error(`Missing OpenAPI reference: ${value.$ref}`);
    }
    for (const child of Object.values(value)) walk(child);
  }
  walk(spec);
}

const count = await checkRouteCoverage();
checkDocument();
const serialized = JSON.stringify(spec, null, 2) + "\n";
if (process.argv.slice(2).join(" ") === "--write") {
  await writeFile(output, serialized);
  console.log(`Wrote OpenAPI 3.1 document for ${count} REST operations.`);
} else if (process.argv.length === 2) {
  if (await readFile(output, "utf8") !== serialized) throw new Error("public/openapi.json is stale; run npm run openapi:generate.");
  console.log(`OpenAPI 3.1 document matches ${count} REST operations and the committed artifact.`);
} else throw new Error("Usage: node scripts/openapi.mjs [--write]");
