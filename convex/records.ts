import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { listInput, recordId, recordInput, recordUpdate,recordCreationKey, page, type AppRecord, type Owner } from "../lib/data/contract";

const ownerFields = { tenant: v.string(), subject: v.string() };
function checkOwner(owner: Owner) {
  if (!owner.tenant || owner.tenant.length > 200 || !owner.subject || owner.subject.length > 200) throw new Error("Invalid owner.");
}
function publicRecord(row: Doc<"records">): AppRecord {
  return { id: row.id, title: row.title, content: row.content, revision: row.revision, createdAt: row.createdAt, updatedAt: row.updatedAt };
}
async function owned(ctx: QueryCtx, owner: Owner, id: string) {
  checkOwner(owner);
  return ctx.db.query("records").withIndex("by_owner_id", q => q.eq("tenant", owner.tenant).eq("subject", owner.subject).eq("id", recordId.parse(id))).unique();
}

// These functions are INTERNAL: the only network entrypoint is the authenticated
// server-to-server HTTP action. They cannot be called by a browser Convex client.
export const list = internalQuery({
  args: { ...ownerFields, limit: v.number(), after: v.optional(v.string()) },
  handler: async (ctx, args) => {
    checkOwner(args);
    const input = listInput.parse({ limit: args.limit, after: args.after });
    const rows = await ctx.db.query("records").withIndex("by_owner_id", q => q.eq("tenant", args.tenant).eq("subject", args.subject).gt("id", input.after ?? "")).order("asc").take(input.limit + 1);
    return page(rows.map(publicRecord), input.limit);
  },
});
export const get = internalQuery({
  args: { ...ownerFields, id: v.string() },
  handler: async (ctx, args) => { const row = await owned(ctx, args, args.id); return row ? publicRecord(row) : null; },
});
export const create = internalMutation({
  args: { ...ownerFields, id: v.string(), title: v.string(), content: v.string() },
  handler: async (ctx, args) => {
    checkOwner(args);
    const id = recordId.parse(args.id);
    const input = recordInput.parse({ title: args.title, content: args.content });
    if (await owned(ctx, args, id)) throw new Error("Duplicate record ID.");
    const now = new Date().toISOString();
    const row = { ...input, id, tenant: args.tenant, subject: args.subject, revision: 1, createdAt: now, updatedAt: now };
    await ctx.db.insert("records", row);
    return { ...input, id, revision: 1, createdAt: now, updatedAt: now };
  },
});
export const creation = internalQuery({
  args: { ...ownerFields,key: v.string() },
  handler: async (ctx,args) => {
    checkOwner(args);
    const key = recordCreationKey.parse(args.key);
    const receipt = await ctx.db.query("recordCreates").withIndex("by_owner_key",q => q.eq("tenant",args.tenant).eq("subject",args.subject).eq("key",key)).unique();
    return receipt ? { id: receipt.id,createdAt: receipt.createdAt } : null;
  },
});
export const createOnce = internalMutation({
  args: { ...ownerFields,key: v.string(),hash: v.string(),id: v.string(),title: v.string(),content: v.string() },
  handler: async (ctx,args) => {
    checkOwner(args);
    const key = recordCreationKey.parse(args.key),id = recordId.parse(args.id);
    if (!/^[a-f0-9]{64}$/u.test(args.hash)) throw new Error("Invalid input hash.");
    const input = recordInput.parse({ title: args.title,content: args.content });
    const receipt = await ctx.db.query("recordCreates").withIndex("by_owner_key",q => q.eq("tenant",args.tenant).eq("subject",args.subject).eq("key",key)).unique();
    if (receipt) {
      if (receipt.hash !== args.hash) return { status: "conflict" as const };
      if (!await owned(ctx,args,receipt.id)) return { status: "deleted" as const };
      return { status: "existing" as const,record: { ...input,id: receipt.id,revision: 1,createdAt: receipt.createdAt,updatedAt: receipt.createdAt } };
    }
    if (await owned(ctx,args,id)) throw new Error("Duplicate record ID.");
    const now = new Date().toISOString();
    await ctx.db.insert("records",{ ...input,id,tenant: args.tenant,subject: args.subject,revision: 1,createdAt: now,updatedAt: now });
    await ctx.db.insert("recordCreates",{ tenant: args.tenant,subject: args.subject,key,hash: args.hash,id,createdAt: now });
    return { status: "created" as const,record: { ...input,id,revision: 1,createdAt: now,updatedAt: now } };
  },
});
export const update = internalMutation({
  args: { ...ownerFields, id: v.string(), title: v.string(), content: v.string(), revision: v.number() },
  handler: async (ctx, args) => {
    const input = recordUpdate.parse({ title: args.title, content: args.content, revision: args.revision });
    const row = await owned(ctx, args, args.id);
    if (!row || row.revision !== input.revision) return null;
    const changes = { ...input, revision: row.revision + 1, updatedAt: new Date().toISOString() };
    await ctx.db.patch(row._id, changes);
    return publicRecord({ ...row, ...changes });
  },
});
export const remove = internalMutation({
  args: { ...ownerFields, id: v.string(), revision: v.number() },
  handler: async (ctx, args) => {
    if (!Number.isSafeInteger(args.revision) || args.revision < 1) throw new Error("Invalid revision.");
    const row = await owned(ctx, args, args.id);
    if (!row || row.revision !== args.revision) return false;
    await ctx.db.delete(row._id);
    return true;
  },
});
export const health = internalQuery({
  args: {},
  handler: async ctx => { await ctx.db.query("records").take(1); return { ready: true }; },
});
