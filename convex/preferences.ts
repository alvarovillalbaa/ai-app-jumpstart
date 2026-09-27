import { v } from "convex/values";
import { internalMutation,internalQuery } from "./_generated/server";
import { defaultPreferences,preferences,preferenceOwner,preferencePatch } from "../lib/preferences/contract";

const owner = { tenant: v.string(),subject: v.string() };
export const get = internalQuery({ args: owner,handler: async (ctx,args) => {
  const o = preferenceOwner.parse(args);
  const row = await ctx.db.query("userPreferences").withIndex("by_owner",q => q.eq("tenant",o.tenant).eq("subject",o.subject)).unique();
  return row ? preferences.parse({ schemaVersion: 1,theme: row.theme,soundEnabled: row.soundEnabled,soundVolume: row.soundVolume,revision: row.revision,updatedAt: row.updatedAt }) : defaultPreferences;
} });
export const update = internalMutation({ args: { ...owner,patch: v.any() },handler: async (ctx,args) => {
  const o = preferenceOwner.parse({ tenant: args.tenant,subject: args.subject }),patch = preferencePatch.parse(args.patch);
  const row = await ctx.db.query("userPreferences").withIndex("by_owner",q => q.eq("tenant",o.tenant).eq("subject",o.subject)).unique();
  if ((row?.revision ?? 0) !== patch.revision) return null;
  const at = new Date().toISOString();
  const saved = preferences.parse({ ...defaultPreferences,...(row ? { theme: row.theme,soundEnabled: row.soundEnabled,soundVolume: row.soundVolume } : {}),
    ...patch,revision: patch.revision+1,updatedAt: at });
  const { schemaVersion: _,...value } = saved;void _;
  if (row) await ctx.db.patch(row._id,{ ...value,updatedAt: at });else await ctx.db.insert("userPreferences",{ ...o,...value,updatedAt: at });
  return saved;
} });
