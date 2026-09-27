import { v } from "convex/values";
import { internalMutation,internalQuery } from "./_generated/server";
import { limitInput,windowResult } from "../lib/request-limits/contract";

export const health = internalQuery({ args: {},handler: async ctx => { await ctx.db.query("requestLimits").take(1);return true; } });

export const claim = internalMutation({ args: { tenant: v.string(),subject: v.string(),limit: v.number() },handler: async (ctx,args) => {
  const input = limitInput.parse(args),now = Date.now(),bucket = Math.floor(now/60000)*60000;
  const row = await ctx.db.query("requestLimits").withIndex("by_owner",q => q.eq("tenant",input.tenant).eq("subject",input.subject)).unique();
  if (row && row.bucket>=bucket && row.counter>=input.limit) return windowResult(false,row.counter,row.bucket,input.limit,now);
  const saved = { bucket: Math.max(bucket,row?.bucket ?? 0),counter: !row || bucket>row.bucket ? 1 : row.counter+1 };
  if (row) await ctx.db.patch(row._id,saved);else await ctx.db.insert("requestLimits",{ tenant: input.tenant,subject: input.subject,...saved });
  return windowResult(true,saved.counter,saved.bucket,input.limit,now);
} });
