import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { accessOwner, reservation, operationId, sessionId, bodyHash, type AccessOwner } from "../lib/agent-access/contract";
import { conversation, conversationTitle, conversationSummary, historyOptions, historyPatch, pageOfHistory } from "../lib/agent-access/contract";
import { projectionEntry, projectionOptions, projectionSourceIndex, pageOfProjections } from "../lib/agent-access/projection-contract";
import { artifactInput, artifactCallId, artifactOptions, artifact, pageOfArtifacts } from "../lib/agent-access/artifact-contract";

const ownerFields = { tenant: v.string(), subject: v.string() };
const sameOwner = (row: AccessOwner, owner: AccessOwner) => row.tenant === owner.tenant && row.subject === owner.subject;
const summary = (row: unknown) => conversationSummary.strip().parse(row);
async function ownedOperation(ctx: QueryCtx, owner: AccessOwner, id: string) {
  accessOwner.parse({ tenant: owner.tenant, subject: owner.subject });
  const row = await ctx.db.query("conversations").withIndex("by_operation", q => q.eq("operationId", operationId.parse(id))).unique();
  return row && sameOwner(row, owner) ? row : null;
}
const publicArtifact = (row: { id: string;operationId: string;sessionId: string;callId: string;title: string;content: string;createdAt: number }) =>
  artifact.parse({ id: row.id,operationId: row.operationId,sourceSessionId: row.sessionId,sourceCallId: row.callId,
    title: row.title,content: row.content,mediaType: "text/plain",createdAt: row.createdAt });
export const saveArtifact = internalMutation({
  args: { ...ownerFields,operationId: v.string(),sessionId: v.string(),callId: v.string(),input: v.object({ title: v.string(),content: v.string() }) },
  handler: async (ctx,args) => {
    const row = await ownedOperation(ctx,args,args.operationId),sid = sessionId.parse(args.sessionId),call = artifactCallId.parse(args.callId),data = artifactInput.parse(args.input);
    if (!row || row.status !== "active" || row.sessionId !== sid) return { status: "unavailable" as const };
    const bytes = new TextEncoder().encode(JSON.stringify(data)),digest = await crypto.subtle.digest("SHA-256",bytes);
    const hash = Array.from(new Uint8Array(digest),byte => byte.toString(16).padStart(2,"0")).join("");
    const existing = await ctx.db.query("artifacts").withIndex("by_operation_call",q => q.eq("operationId",args.operationId).eq("callId",call)).unique();
    if (existing) return existing.deletedAt !== undefined ? { status: "unavailable" as const } : existing.inputHash !== hash ? { status: "conflict" as const } : { status: "existing" as const,artifact: publicArtifact(existing) };
    const saved = { id: crypto.randomUUID(),tenant: row.tenant,subject: row.subject,operationId: row.operationId,sessionId: sid,callId: call,
      inputHash: hash,title: data.title,content: data.content,createdAt: Date.now() };
    await ctx.db.insert("artifacts",saved);
    return { status: "created" as const,artifact: publicArtifact(saved) };
  },
});
export const getArtifact = internalQuery({
  args: { ...ownerFields,id: v.string() },
  handler: async (ctx,args) => {
    const owner = accessOwner.parse({ tenant: args.tenant,subject: args.subject });
    const row = await ctx.db.query("artifacts").withIndex("by_external_id",q => q.eq("id",operationId.parse(args.id))).unique();
    return row && sameOwner(row,owner) && row.deletedAt === undefined ? publicArtifact(row) : null;
  },
});
export const deleteArtifact = internalMutation({
  args: { ...ownerFields,id: v.string() },
  handler: async (ctx,args) => {
    const owner = accessOwner.parse({ tenant: args.tenant,subject: args.subject });
    const row = await ctx.db.query("artifacts").withIndex("by_external_id",q => q.eq("id",operationId.parse(args.id))).unique();
    if (!row || !sameOwner(row,owner) || row.deletedAt !== undefined) return false;
    await ctx.db.patch(row._id,{ title: "Deleted artifact",content: " ",inputHash: "0".repeat(64),deletedAt: Date.now() });
    return true;
  },
});
export const listArtifacts = internalQuery({
  args: { ...ownerFields,options: v.object({ limit: v.number(),cursor: v.optional(v.string()) }) },
  handler: async (ctx,args) => {
    const owner = accessOwner.parse({ tenant: args.tenant,subject: args.subject }),q = artifactOptions.parse(args.options);
    if (!q.cursor) {
      const rows = await ctx.db.query("artifacts").withIndex("by_owner_time",index => index.eq("tenant",owner.tenant).eq("subject",owner.subject)).filter(filter => filter.eq(filter.field("deletedAt"),undefined)).order("desc").take(q.limit+1);
      return pageOfArtifacts(rows.map(publicArtifact),q.limit);
    }
    const [time,id] = q.cursor.split("."),timestamp = Number(time);
    const [sameTime,earlier] = await Promise.all([
      ctx.db.query("artifacts").withIndex("by_owner_time",index => index.eq("tenant",owner.tenant).eq("subject",owner.subject).eq("createdAt",timestamp).lt("id",id)).filter(filter => filter.eq(filter.field("deletedAt"),undefined)).order("desc").take(q.limit+1),
      ctx.db.query("artifacts").withIndex("by_owner_time",index => index.eq("tenant",owner.tenant).eq("subject",owner.subject).lt("createdAt",timestamp)).filter(filter => filter.eq(filter.field("deletedAt"),undefined)).order("desc").take(q.limit+1),
    ]);
    return pageOfArtifacts([...sameTime,...earlier].map(publicArtifact),q.limit);
  },
});
// Serializable internal mutations enforce uniqueness across concurrent writers.
export const appendProjection = internalMutation({
  args: { ...ownerFields,operationId: v.string(),sessionId: v.string(),entry: v.any(),sourceIndex: v.optional(v.number()) },
  handler: async (ctx,args) => {
    const entry = projectionEntry.parse(args.entry), row = await ownedOperation(ctx,args,args.operationId);
    if (!row || row.status !== "active" || row.sessionId !== sessionId.parse(args.sessionId)) return "unavailable";
    const source = args.sourceIndex === undefined ? undefined : projectionSourceIndex.parse(args.sourceIndex);
    const existing = await ctx.db.query("conversationEvents").withIndex("by_operation_event",q => q.eq("operationId",args.operationId).eq("eventId",entry.eventId)).unique();
    const payload = JSON.stringify(entry);
    if (existing) {
      if (existing.payload !== payload || source !== undefined && existing.sourceIndex !== undefined && existing.sourceIndex !== source) return "conflict";
      if (source !== undefined && existing.sourceIndex === undefined) {
        const taken = await ctx.db.query("conversationEvents").withIndex("by_operation_source",q => q.eq("operationId",args.operationId).eq("sourceIndex",source)).first();
        if (taken) return "conflict";
        await ctx.db.patch(existing._id,{ sourceIndex: source });
      }
      return "duplicate";
    }
    if (source !== undefined) {
      const taken = await ctx.db.query("conversationEvents").withIndex("by_operation_source",q => q.eq("operationId",args.operationId).eq("sourceIndex",source)).first();
      if (taken) return "conflict";
    }
    const ordinal = (row.projectionSequence ?? 0)+1;
    await ctx.db.patch(row._id,{ projectionSequence: ordinal });
    await ctx.db.insert("conversationEvents",{ operationId: args.operationId,eventId: entry.eventId,ordinal,payload,...(source === undefined ? {} : { sourceIndex: source }) });
    return "inserted";
  },
});
export const listProjections = internalQuery({
  args: { ...ownerFields,operationId: v.string(),options: v.object({ limit: v.number(),after: v.optional(v.number()) }) },
  handler: async (ctx,args) => {
    const q = projectionOptions.parse(args.options), row = await ownedOperation(ctx,args,args.operationId);
    if (!row) return pageOfProjections([],q.limit);
    const events = await ctx.db.query("conversationEvents").withIndex("by_operation_ordinal",index => index.eq("operationId",args.operationId).gt("ordinal",q.after ?? 0)).order("asc").take(q.limit+1);
    return pageOfProjections(events.map(event => ({ entry: JSON.parse(event.payload),index: event.ordinal,sourceIndex: event.sourceIndex })),q.limit);
  },
});
// No public query/mutation can attach sessions or claim nonce receipts.
export const reserve = internalMutation({
  args: { ...ownerFields, id: v.string(), operationId: v.string(), requestHash: v.string(), title: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const { title,...raw } = args;
    const input = reservation.parse(raw);
    if (await ctx.db.query("conversations").withIndex("by_external_id", q => q.eq("id", input.id)).unique()) return false;
    if (await ctx.db.query("conversations").withIndex("by_operation", q => q.eq("operationId", input.operationId)).unique()) return false;
    await ctx.db.insert("conversations", { ...input, sessionId: null, status: "starting", title: conversationTitle.parse(title ?? "New conversation"), createdAt: Date.now(), archived: false, revision: 1 });
    return true;
  },
});
export const getOperation = internalQuery({
  args: { ...ownerFields, operationId: v.string() },
  handler: async (ctx, args) => {
    const row = await ownedOperation(ctx, args, args.operationId);
    if (!row) return null;
    return conversation.strip().parse(row);
  },
});
export const list = internalQuery({
  args: { ...ownerFields, options: v.object({ limit: v.number(), archived: v.boolean(), cursor: v.optional(v.string()) }) },
  handler: async (ctx,args) => {
    const owner = accessOwner.parse({ tenant: args.tenant, subject: args.subject }), options = historyOptions.parse(args.options);
    const legacy = await ctx.db.query("conversations").withIndex("by_history",q => q.eq("tenant",owner.tenant).eq("subject",owner.subject).eq("archived",undefined)).first();
    if (legacy) throw new Error("Run access:backfillMetadata before listing legacy conversation history.");
    if (!options.cursor) {
      const rows = await ctx.db.query("conversations").withIndex("by_history",q => q.eq("tenant",owner.tenant).eq("subject",owner.subject).eq("archived",options.archived)).order("desc").take(options.limit+1);
      return pageOfHistory(rows.map(summary),options.limit);
    }
    const [time,id] = options.cursor.split("."), timestamp = Number(time);
    const [sameTime,earlier] = await Promise.all([
      ctx.db.query("conversations").withIndex("by_history",q => q.eq("tenant",owner.tenant).eq("subject",owner.subject).eq("archived",options.archived).eq("createdAt",timestamp).lt("id",id)).order("desc").take(options.limit+1),
      ctx.db.query("conversations").withIndex("by_history",q => q.eq("tenant",owner.tenant).eq("subject",owner.subject).eq("archived",options.archived).lt("createdAt",timestamp)).order("desc").take(options.limit+1),
    ]);
    return pageOfHistory([...sameTime,...earlier].map(summary),options.limit);
  },
});
export const getDetails = internalQuery({
  args: { ...ownerFields, operationId: v.string() },
  handler: async (ctx,args) => {
    const row = await ownedOperation(ctx,args,args.operationId);
    if (!row) return null;
    if (row.archived === undefined) throw new Error("Run access:backfillMetadata before reading legacy conversation history.");
    return summary(row);
  },
});
export const updateDetails = internalMutation({
  args: { ...ownerFields, operationId: v.string(), patch: v.object({ revision: v.number(), title: v.optional(v.string()), archived: v.optional(v.boolean()) }) },
  handler: async (ctx,args) => {
    const patch = historyPatch.parse(args.patch), row = await ownedOperation(ctx,args,args.operationId);
    if (!row || (row.revision ?? 1) !== patch.revision) return null;
    const changed = { title: patch.title ?? row.title ?? "New conversation", createdAt: row.createdAt ?? Math.floor(row._creationTime), archived: patch.archived ?? row.archived ?? false, revision: patch.revision+1 };
    await ctx.db.patch(row._id,changed);
    return summary({ ...row,...changed });
  },
});
/** Admin CLI migration only. Repeat until remaining is false; never a public API. */
export const backfillMetadata = internalMutation({
  args: {},
  handler: async ctx => {
    const rows = await ctx.db.query("conversations").withIndex("by_archived",q => q.eq("archived",undefined)).take(100);
    for (const row of rows) await ctx.db.patch(row._id,{ title: "New conversation", createdAt: Math.floor(row._creationTime), archived: false, revision: 1 });
    return { updated: rows.length, remaining: !!await ctx.db.query("conversations").withIndex("by_archived",q => q.eq("archived",undefined)).first() };
  },
});
export const bind = internalMutation({
  args: { ...ownerFields, operationId: v.string(), sessionId: v.string() },
  handler: async (ctx, args) => {
    const target = sessionId.parse(args.sessionId), row = await ownedOperation(ctx, args, args.operationId);
    if (!row || row.status === "revoked") return false;
    if (row.status === "active") return row.sessionId === target;
    if (await ctx.db.query("conversations").withIndex("by_session", q => q.eq("sessionId", target)).unique()) return false;
    await ctx.db.patch(row._id, { sessionId: target, status: "active" });
    return true;
  },
});
export const ownsSession = internalQuery({
  args: { ...ownerFields, sessionId: v.string() },
  handler: async (ctx, args) => {
    accessOwner.parse({ tenant: args.tenant, subject: args.subject });
    const row = await ctx.db.query("conversations").withIndex("by_session", q => q.eq("sessionId", sessionId.parse(args.sessionId))).unique();
    return !!row && sameOwner(row, args) && row.status === "active";
  },
});
export const cancelStarting = internalMutation({
  args: { ...ownerFields, operationId: v.string() },
  handler: async (ctx, args) => {
    const row = await ownedOperation(ctx,args,args.operationId);
    if (!row || row.status !== "starting" || row.sessionId !== null) return false;
    await ctx.db.patch(row._id, { status: "revoked" });
    return true;
  },
});
export const revoke = internalMutation({
  args: { ...ownerFields, id: v.string() },
  handler: async (ctx, args) => {
    accessOwner.parse({ tenant: args.tenant, subject: args.subject });
    const row = await ctx.db.query("conversations").withIndex("by_external_id", q => q.eq("id", operationId.parse(args.id))).unique();
    if (!row || !sameOwner(row, args)) return false;
    await ctx.db.patch(row._id, { status: "revoked" });
    return true;
  },
});
export const claimNonce = internalMutation({
  args: { id: v.string(), expiresAt: v.number(), now: v.number() },
  handler: async (ctx, args) => {
    bodyHash.parse(args.id);
    if (!Number.isSafeInteger(args.now) || !Number.isSafeInteger(args.expiresAt) || args.now <= 0 || args.expiresAt <= args.now) throw new Error("Invalid nonce retention window.");
    const expired = await ctx.db.query("internalNonces").withIndex("by_expiry", q => q.lt("expiresAt", args.now)).take(1000);
    for (const row of expired) await ctx.db.delete(row._id);
    if (await ctx.db.query("internalNonces").withIndex("by_external_id", q => q.eq("id", args.id)).unique()) return false;
    await ctx.db.insert("internalNonces", { id: args.id, expiresAt: args.expiresAt });
    return true;
  },
});
