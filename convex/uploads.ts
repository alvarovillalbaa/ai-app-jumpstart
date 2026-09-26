import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { accessOwner, type AccessOwner } from "../lib/agent-access/contract";
import { uploadCleanupCandidates, uploadCleanupLimit, withUploadScan, uploadScanDecision, uploadList, uploadQuota, uploadReservation, uploadUsage, staleUploadCutoff } from "../lib/uploads/catalog-contract";
import { uploadId } from "../lib/uploads/schema";

const ownerFields = { tenant: v.string(),subject: v.string() };
const sameOwner = (row: AccessOwner,owner: AccessOwner) => row.tenant === owner.tenant && row.subject === owner.subject;
async function ownedRow(ctx: QueryCtx, rawOwner: AccessOwner, rawId: string) {
  const owner = accessOwner.parse({ tenant: rawOwner.tenant,subject: rawOwner.subject }),id = uploadId.parse(rawId);
  const row = await ctx.db.query("uploads").withIndex("by_external_id",q => q.eq("id",id)).unique();
  return row && sameOwner(row,owner) ? row : null;
}
async function activeRows(ctx: QueryCtx, owner: AccessOwner) {
  const states = ["pending","quarantined","clean","rejected","deleting"] as const;
  const groups = await Promise.all(states.map(state => ctx.db.query("uploads")
    .withIndex("by_owner_state",q => q.eq("tenant",owner.tenant).eq("subject",owner.subject).eq("state",state)).collect()));
  return groups.flat();
}
const publicEntry = (row: { id: string;name: string;mediaType: string;size: number;sha256: string;createdAt: number;state: string;scan?: unknown }) =>
  withUploadScan({ id: row.id,name: row.name,mediaType: row.mediaType,size: row.size,sha256: row.sha256,createdAt: row.createdAt,state: row.state },row.scan);

export const reserve = internalMutation({
  args: { ...ownerFields,input: v.any(),quota: v.any() },
  handler: async (ctx,args) => {
    const owner = accessOwner.parse({ tenant: args.tenant,subject: args.subject });
    const input = uploadReservation.parse(args.input),quota = uploadQuota.parse(args.quota);
    const existing = await ctx.db.query("uploads").withIndex("by_external_id",q => q.eq("id",input.id)).unique();
    if (existing) return sameOwner(existing,owner) && existing.name === input.name && existing.mediaType === input.mediaType &&
      existing.size === input.size && existing.sha256 === input.sha256 ? "existing" as const : "conflict" as const;
    const active = await activeRows(ctx,owner);
    if (active.length >= quota.maxFiles || active.reduce((sum,row) => sum+row.size,0)+input.size > quota.maxBytes) return "quota" as const;
    await ctx.db.insert("uploads",{ ...owner,...input,state: "pending" });
    return "reserved" as const;
  },
});
export const markStored = internalMutation({
  args: { ...ownerFields,id: v.string() },
  handler: async (ctx,args) => {
    const row = await ownedRow(ctx,args,args.id);
    if (!row) return false;
    if (row.state === "pending") { await ctx.db.patch(row._id,{ state: "quarantined" });return true; }
    return row.state === "quarantined" || row.state === "clean" || row.state === "rejected";
  },
});
export const get = internalQuery({
  args: { ...ownerFields,id: v.string() },
  handler: async (ctx,args) => { const row = await ownedRow(ctx,args,args.id);return row ? publicEntry(row) : null; },
});
export const recordScan = internalMutation({
  args: { ...ownerFields,id: v.string(),decision: v.any() },
  handler: async (ctx,args) => {
    const decision = uploadScanDecision.parse(args.decision),row = await ownedRow(ctx,args,args.id);
    if (!row || row.state !== "quarantined" && row.state !== "clean" || row.sha256 !== decision.sha256 || row.scan?.status === "rejected" ||
        decision.status === "clean" && row.scan && row.scan.checkedAt > decision.checkedAt) return false;
    await ctx.db.patch(row._id,{ state: decision.status,scan: decision });
    return true;
  },
});
export const list = internalQuery({
  args: ownerFields,
  handler: async (ctx,args) => {
    const owner = accessOwner.parse(args);
    const rows = await activeRows(ctx,owner);
    return uploadList.parse(rows.sort((a,b) => b.createdAt-a.createdAt || b.id.localeCompare(a.id)).map(publicEntry));
  },
});
export const listCleanupCandidates = internalQuery({
  args: { cutoff: v.number(),limit: v.number() },
  handler: async (ctx,args) => {
    const cutoff = staleUploadCutoff.parse(args.cutoff),limit = uploadCleanupLimit.parse(args.limit);
    const groups = await Promise.all((["pending","deleting"] as const).map(state => ctx.db.query("uploads")
      .withIndex("by_cleanup",q => q.eq("state",state).lte("createdAt",cutoff)).take(limit)));
    return uploadCleanupCandidates.parse(groups.flat()
      .sort((a,b) => a.createdAt-b.createdAt || a.id.localeCompare(b.id)).slice(0,limit)
      .map(row => ({ tenant: row.tenant,subject: row.subject,id: row.id,state: row.state,createdAt: row.createdAt })));
  },
});
export const beginDelete = internalMutation({
  args: { ...ownerFields,id: v.string() },
  handler: async (ctx,args) => {
    const row = await ownedRow(ctx,args,args.id);
    if (!row) return false;
    if (["pending","quarantined","clean","rejected"].includes(row.state)) { await ctx.db.patch(row._id,{ state: "deleting" });return true; }
    return row.state === "deleting";
  },
});
export const claimStalePending = internalMutation({
  args: { ...ownerFields,id: v.string(),cutoff: v.number() },
  handler: async (ctx,args) => {
    const cutoff = staleUploadCutoff.parse(args.cutoff),row = await ownedRow(ctx,args,args.id);
    if (!row || row.state !== "pending" || row.createdAt > cutoff) return false;
    await ctx.db.patch(row._id,{ state: "deleting" });
    return true;
  },
});
export const finishDelete = internalMutation({
  args: { ...ownerFields,id: v.string() },
  handler: async (ctx,args) => {
    const row = await ownedRow(ctx,args,args.id);
    if (!row) return false;
    if (row.state === "deleting") { await ctx.db.patch(row._id,{ state: "deleted" });return true; }
    return row.state === "deleted";
  },
});
export const usage = internalQuery({
  args: ownerFields,
  handler: async (ctx,args) => {
    const owner = accessOwner.parse(args),rows = await activeRows(ctx,owner);
    return uploadUsage.parse({ files: rows.length,bytes: rows.reduce((sum,row) => sum+row.size,0) });
  },
});
