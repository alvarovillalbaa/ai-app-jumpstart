import type { MutationCtx } from "./_generated/server";

/** This indexed read shares the mutation transaction with the write. Convex's
 * serializable conflict detection orders it against an operator fence insert. */
export async function assertAccountOpen(ctx: MutationCtx,owner: { tenant: string;subject: string }) {
  if (!owner.tenant || !owner.subject || owner.tenant.length > 200 || owner.subject.length > 200)
    throw new Error("Invalid account owner.");
  const fenced = await ctx.db.query("accountFences").withIndex("by_owner",q =>
    q.eq("tenant",owner.tenant).eq("subject",owner.subject)).unique();
  if (fenced) throw new Error("Account application writes are fenced.");
}
