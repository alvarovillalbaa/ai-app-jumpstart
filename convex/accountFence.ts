import type { MutationCtx,QueryCtx } from "./_generated/server";

export async function isAccountFenced(ctx: QueryCtx | MutationCtx,owner: { tenant: string;subject: string }) {
  if (!owner.tenant || !owner.subject || owner.tenant.length > 200 || owner.subject.length > 200)
    throw new Error("Invalid account owner.");
  return !!await ctx.db.query("accountFences").withIndex("by_owner",q =>
    q.eq("tenant",owner.tenant).eq("subject",owner.subject)).unique();
}

/** This indexed read shares the mutation transaction with the write. Convex's
 * serializable conflict detection orders it against an operator fence insert. */
export async function assertAccountOpen(ctx: MutationCtx,owner: { tenant: string;subject: string }) {
  if (await isAccountFenced(ctx,owner)) throw new Error("Account application writes are fenced.");
}
