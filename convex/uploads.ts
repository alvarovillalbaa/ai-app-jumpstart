import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { accessOwner, type AccessOwner } from "../lib/agent-access/contract";
import { uploadEntry, uploadList, uploadQuota, uploadReservation, uploadUsage } from "../lib/uploads/catalog-contract";
import { uploadId } from "../lib/uploads/schema";

const ownerFields = { tenant: v.string(),subject: v.string() };
const sameOwner = (row: AccessOwner,owner: AccessOwner) => row.tenant === owner.tenant && row.subject === owner.subject;
async function ownedRow(ctx: QueryCtx, rawOwner: AccessOwner, rawId: string) {
  const owner = accessOwner.parse({ tenant: rawOwner.tenant,subject: rawOwner.subject }),id = uploadId.parse(rawId);
  const row = await ctx.db.query("uploads").withIndex("by_external_id",q => q.eq("id",id)).unique();
  return row && sameOwner(row,owner) ? row : null;
}
async function activeRows(ctx: QueryCtx, owner: AccessOwner) {
  const states = ["pending","quarantined","deleting"] as const;
  const groups = await Promise.all(states.map(state => ctx.db.query("uploads")
    .withIndex("by_owner_state",q => q.eq("tenant",owner.tenant).eq("subject",owner.subject).eq("state",state)).collect()));
  return groups.flat();
}
const publicEntry = (row: { id: string;name: string;mediaType: string;size: number;sha256: string;createdAt: number;state: string }) =>
  uploadEntry.parse({ id: row.id,name: row.name,mediaType: row.mediaType,size: row.size,sha256: row.sha256,createdAt: row.createdAt,state: row.state });

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
    return row.state === "quarantined";
  },
});
export const get = internalQuery({
  args: { ...ownerFields,id: v.string() },
  handler: async (ctx,args) => { const row = await ownedRow(ctx,args,args.id);return row ? publicEntry(row) : null; },
});
export const list = internalQuery({
  args: ownerFields,
  handler: async (ctx,args) => {
    const owner = accessOwner.parse(args);
    const rows = await activeRows(ctx,owner);
    return uploadList.parse(rows.sort((a,b) => b.createdAt-a.createdAt || b.id.localeCompare(a.id)).map(publicEntry));
  },
});
export const beginDelete = internalMutation({
  args: { ...ownerFields,id: v.string() },
  handler: async (ctx,args) => {
    const row = await ownedRow(ctx,args,args.id);
    if (!row) return false;
    if (row.state === "pending" || row.state === "quarantined") { await ctx.db.patch(row._id,{ state: "deleting" });return true; }
    return row.state === "deleting";
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
