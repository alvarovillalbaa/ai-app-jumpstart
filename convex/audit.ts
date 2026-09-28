import { v } from "convex/values";
import { internalQuery,type QueryCtx } from "./_generated/server";

// Kept in lockstep with the classified Convex tables in account-data-inventory.mjs.
// These queries return counts only; they never return application rows.
export const accountAuditEntities = [
  "records","recordCreates","conversations","conversationEvents","conversationRuns",
  "artifacts","artifactVersions","budgetAccounts","budgetDays","budgetReservations",
  "budgetAttempts","budgetCorrections","uploads","uploadReviews","userPreferences","requestLimits",
] as const;

type Entity = typeof accountAuditEntities[number];
const childEntities = new Set<Entity>(["conversationEvents","conversationRuns","artifacts","artifactVersions","budgetAttempts","uploadReviews"]);

async function parentOwner(ctx: QueryCtx, entity: Entity, row: Record<string, unknown>) {
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
