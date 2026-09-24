import { httpRouter } from "convex/server";
import { z } from "zod";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { listInput, recordId, recordInput, recordUpdate } from "../lib/data/contract";
import { accessCommand } from "../lib/agent-access/contract";
import { budgetCommand } from "../lib/budgets/contract";
import { uploadCatalogCommand } from "../lib/uploads/catalog-contract";

const owner = z.object({ tenant: z.string().min(1).max(200), subject: z.string().min(1).max(200) });
const command = z.discriminatedUnion("operation", [
  owner.extend({ operation: z.literal("list"), ...listInput.shape }).strict(),
  owner.extend({ operation: z.literal("get"), id: recordId }).strict(),
  owner.extend({ operation: z.literal("create"), id: recordId, ...recordInput.shape }).strict(),
  owner.extend({ operation: z.literal("update"), id: recordId, ...recordUpdate.shape }).strict(),
  owner.extend({ operation: z.literal("delete"), id: recordId, revision: z.number().int().positive() }).strict(),
  z.object({ operation: z.literal("health") }).strict(),
]);
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

async function authorized(request: Request) {
  const expected = process.env.CONVEX_BACKEND_SECRET;
  if (!expected || expected.length < 32) return false;
  const supplied = request.headers.get("x-jumpstart-backend-key") ?? "";
  if (supplied.length < 32 || supplied.length > 512) return false;
  // Web Crypto is supported by the Convex isolate; do not import Node crypto.
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(expected), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const bytes = new TextEncoder().encode("jumpstart-backend-auth-v1");
  const suppliedKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(supplied), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.verify("HMAC", key, await crypto.subtle.sign("HMAC", suppliedKey, bytes), bytes);
}

const http = httpRouter();
http.route({ path: "/app/records", method: "POST", handler: httpAction(async (ctx, request) => {
  if (!await authorized(request)) return json({ error: "unauthorized" }, 401);
  if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "unsupported_media_type" }, 415);
  let raw: unknown;
  // Bound the stream rather than trusting Content-Length from the caller.
  const reader = request.body?.getReader();
  if (!reader) return json({ error: "invalid_input" }, 400);
  let text = "", size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 131072) { await reader.cancel(); return json({ error: "body_too_large" }, 413); }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    raw = JSON.parse(text);
  } catch { return json({ error: "invalid_input" }, 400); }
  finally { reader.releaseLock(); }
  const parsed = z.union([command, accessCommand, budgetCommand, uploadCatalogCommand]).safeParse(raw);
  if (!parsed.success) return json({ error: "invalid_input" }, 400);
  try {
    // Narrow each command before dispatch; Convex argument validators also run.
    switch (parsed.data.operation) {
      case "upload.reserve": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.uploads.reserve,input)); }
      case "upload.markStored": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.uploads.markStored,input)); }
      case "upload.get": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.uploads.get,input)); }
      case "upload.beginDelete": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.uploads.beginDelete,input)); }
      case "upload.finishDelete": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.uploads.finishDelete,input)); }
      case "upload.usage": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.uploads.usage,input)); }
      case "budget.claimAttempt": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.budgets.claimAttempt, { input })); }
      case "budget.attemptCount": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.budgets.attemptCount, { input })); }
      case "budget.getReservation": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.budgets.getReservation, { input })); }
      case "budget.inspectReservation": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.budgets.inspectReservation, { input })); }
      case "budget.listCorrections": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.budgets.listCorrections, { input })); }
      case "budget.listOutstanding": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.budgets.listOutstanding, { input })); }
      case "budget.reserve": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.budgets.reserve, { input })); }
      case "budget.settle": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.budgets.settle, { input })); }
      case "budget.correctSettlement": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.budgets.correctSettlement, { input })); }
      case "budget.snapshot": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.budgets.snapshot, { input })); }
      case "access.reserve": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.access.reserve, input)); }
      case "access.list": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.access.list, input)); }
      case "access.appendProjection": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.access.appendProjection, input)); }
      case "access.listProjections": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.access.listProjections, input)); }
      case "access.saveArtifact": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.access.saveArtifact, input)); }
      case "access.listArtifacts": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.access.listArtifacts, input)); }
      case "access.getArtifact": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.access.getArtifact, input)); }
      case "access.deleteArtifact": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.access.deleteArtifact, input)); }
      case "access.getDetails": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.access.getDetails, input)); }
      case "access.updateDetails": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.access.updateDetails, input)); }
      case "access.getOperation": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.access.getOperation, input)); }
      case "access.bind": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.access.bind, input)); }
      case "access.cancelStarting": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.access.cancelStarting, input)); }
      case "access.ownsSession": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.access.ownsSession, input)); }
      case "access.revoke": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.access.revoke, input)); }
      case "access.claimNonce": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.access.claimNonce, input)); }
      case "list": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.records.list, input)); }
      case "get": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runQuery(internal.records.get, input)); }
      case "create": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.records.create, input)); }
      case "update": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.records.update, input)); }
      case "delete": { const { operation: _, ...input } = parsed.data; void _; return json(await ctx.runMutation(internal.records.remove, input)); }
      case "health": return json(await ctx.runQuery(internal.records.health, {}));
    }
  } catch { return json({ error: "storage_error" }, 500); }
}) });
export default http;
