import { v } from "convex/values";
import { internalMutation,internalQuery,type MutationCtx,type QueryCtx } from "./_generated/server";

// Kept in lockstep with the classified Convex tables in account-data-inventory.mjs.
// The operator-only endpoint uses this allowlist for counts, raw export and deletion.
export const accountAuditEntities = [
  "records","recordCreates","conversations","conversationEvents","conversationRuns",
  "artifacts","artifactVersions","budgetAccounts","budgetDays","budgetReservations",
  "budgetAttempts","budgetCorrections","uploads","uploadReviews","userPreferences","requestLimits",
] as const;

type Entity = typeof accountAuditEntities[number];
const childEntities = new Set<Entity>(["conversationEvents","conversationRuns","artifacts","artifactVersions","budgetAttempts","uploadReviews"]);

async function parentOwner(ctx: QueryCtx | MutationCtx, entity: Entity, row: Record<string, unknown>) {
  if (entity === "conversationEvents" || entity === "conversationRuns" || entity === "artifacts") {
    const parent = await ctx.db.query("conversations").withIndex("by_operation",q => q.eq("operationId",row.operationId as string)).unique();
    if (entity === "artifacts" && parent && (row.tenant !== parent.tenant || row.subject !== parent.subject)) return null;
    return parent && { tenant: parent.tenant,subject: parent.subject };
  }
  if (entity === "artifactVersions") {
    const parent = await ctx.db.query("artifacts").withIndex("by_external_id",q => q.eq("id",row.artifactId as string)).unique();
    if (!parent) return null;
    const conversation = await ctx.db.query("conversations").withIndex("by_operation",q => q.eq("operationId",parent.operationId)).unique();
    return conversation && parent.tenant === conversation.tenant && parent.subject === conversation.subject
      ? { tenant: conversation.tenant,subject: conversation.subject } : null;
  }
  if (entity === "budgetAttempts") {
    const parent = await ctx.db.query("budgetReservations").withIndex("by_operation",q => q.eq("operationId",row.operationId as string)).unique();
    return parent && { tenant: parent.tenant,subject: parent.subject };
  }
  if (entity === "uploadReviews") {
    const parent = await ctx.db.query("uploads").withIndex("by_external_id",q => q.eq("id",row.uploadId as string)).unique();
    return parent && { tenant: parent.tenant,subject: parent.subject };
  }
  return { tenant: row.tenant,subject: row.subject };
}

/** One bounded Convex snapshot. An operator must page every entity to inspect a deployment. */
export const accountPage = internalQuery({
  args: { entity: v.string(),tenant: v.string(),subject: v.string(),cursor: v.union(v.string(),v.null()) },
  handler: async (ctx,args) => {
    if (!accountAuditEntities.includes(args.entity as Entity) || !args.tenant || !args.subject) throw new Error("Invalid account audit request.");
    const entity = args.entity as Entity;
    const page = await ctx.db.query(entity).paginate({ numItems: 100,cursor: args.cursor });
    let owned = 0,orphans = 0;
    for (const item of page.page) {
      const owner = await parentOwner(ctx,entity,item as unknown as Record<string, unknown>);
      if (!owner) { if (childEntities.has(entity)) orphans++;continue; }
      if (owner.tenant === args.tenant && owner.subject === args.subject) owned++;
    }
    return { owned,orphans,scanned: page.page.length,done: page.isDone,cursor: page.isDone ? null : page.continueCursor };
  },
});

/** Operator-only raw rows. A small page bounds the HTTP response even when rows contain private content. */
export const accountRowPage = internalQuery({
  args: { entity: v.string(),tenant: v.string(),subject: v.string(),cursor: v.union(v.string(),v.null()) },
  handler: async (ctx,args) => {
    if (!accountAuditEntities.includes(args.entity as Entity) || !args.tenant || !args.subject ||
        args.tenant.length > 200 || args.subject.length > 200) throw new Error("Invalid account row export request.");
    const entity = args.entity as Entity;
    const page = await ctx.db.query(entity).paginate({ numItems: 10,cursor: args.cursor });
    const rows: Record<string,unknown>[] = [];
    let orphans = 0;
    for (const item of page.page) {
      const owner = await parentOwner(ctx,entity,item as unknown as Record<string,unknown>);
      if (!owner) { if (childEntities.has(entity)) orphans++;continue; }
      if (owner.tenant === args.tenant && owner.subject === args.subject)
        rows.push(item as unknown as Record<string,unknown>);
    }
    return { rows,orphans,scanned: page.page.length,done: page.isDone,
      cursor: page.isDone ? null : page.continueCursor };
  },
});

export const accountFenceStatus = internalQuery({
  args: { tenant: v.string(),subject: v.string() },
  handler: async (ctx,args) => {
    if (!args.tenant || !args.subject || args.tenant.length > 200 || args.subject.length > 200)
      throw new Error("Invalid account fence owner.");
    return { fenced: !!await ctx.db.query("accountFences").withIndex("by_owner",q =>
      q.eq("tenant",args.tenant).eq("subject",args.subject)).unique() };
  },
});

/** Called only by the distinct operator audit endpoint. There is no un-fence. */
export const setAccountFence = internalMutation({
  args: { tenant: v.string(),subject: v.string() },
  handler: async (ctx,args) => {
    if (!args.tenant || !args.subject || args.tenant.length > 200 || args.subject.length > 200)
      throw new Error("Invalid account fence owner.");
    const existing = await ctx.db.query("accountFences").withIndex("by_owner",q =>
      q.eq("tenant",args.tenant).eq("subject",args.subject)).unique();
    if (existing) return { status: "fenced" as const,created: false };
    await ctx.db.insert("accountFences",{ ...args,createdAt: Date.now() });
    return { status: "fenced" as const,created: true };
  },
});

/** Operator-only, bounded, retryable physical deletion; the permanent fence is never removed. */
export const eraseAccountRows = internalMutation({
  args: { entity: v.string(),tenant: v.string(),subject: v.string(),ids: v.array(v.string()) },
  handler: async (ctx,args) => {
    if (!accountAuditEntities.includes(args.entity as Entity) || !args.tenant || !args.subject ||
        args.tenant.length > 200 || args.subject.length > 200 ||
        args.ids.length < 1 || args.ids.length > 10 || new Set(args.ids).size !== args.ids.length)
      throw new Error("Invalid account row erasure request.");
    const entity = args.entity as Entity;
    const fence = await ctx.db.query("accountFences").withIndex("by_owner",q =>
      q.eq("tenant",args.tenant).eq("subject",args.subject)).unique();
    if (!fence) throw new Error("Account rows must be permanently fenced before erasure.");
    const found = [];
    for (const rawId of args.ids) {
      const id = ctx.db.normalizeId(entity,rawId);
      if (!id) throw new Error("Account row ID does not belong to the selected table.");
      const row = await ctx.db.get(entity,id);
      if (!row) continue;
      const owner = await parentOwner(ctx,entity,row as Record<string,unknown>);
      if (!owner || owner.tenant !== args.tenant || owner.subject !== args.subject)
        throw new Error("Account row does not belong to the selected owner.");
      found.push(id);
    }
    for (const id of found) await ctx.db.delete(entity,id);
    return { removed: found.length,missing: args.ids.length-found.length };
  },
});
