import { v } from "convex/values";
import { internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { admission, settlement, settlementCorrection, correctionEntry, lookup, dayOf, refusal, attempt, attemptOwner, outstandingOptions, outstandingEntry, pageOfOutstanding } from "../lib/budgets/contract";

async function state(ctx: QueryCtx, input: ReturnType<typeof lookup.parse>) {
  const day = dayOf(input.now);
  const account = await ctx.db.query("budgetAccounts").withIndex("by_owner", q => q.eq("tenant",input.tenant).eq("subject",input.subject)).unique();
  const totals = await ctx.db.query("budgetDays").withIndex("by_owner_day", q => q.eq("tenant",input.tenant).eq("subject",input.subject).eq("day",day)).unique();
  const recent = await ctx.db.query("budgetReservations").withIndex("by_owner_time", q => q.eq("tenant",input.tenant).eq("subject",input.subject).gt("createdAt",input.now-60000)).take(1001);
  return { account, totals, snapshot: { day, reservedMicros: totals?.reservedMicros ?? 0, chargedMicros: totals?.chargedMicros ?? 0, unknownCosts: totals?.unknownCosts ?? 0, active: account?.active ?? 0, recent: recent.length } };
}
export const reserve = internalMutation({ args: { input: v.any() }, handler: async (ctx, args) => {
  const input = admission.parse(args.input);
  const existing = await ctx.db.query("budgetReservations").withIndex("by_operation", q => q.eq("operationId",input.operationId)).unique();
  if (existing) {
    if (existing.tenant!==input.tenant || existing.subject!==input.subject || existing.requestHash!==input.requestHash || existing.estimateMicros!==input.estimateMicros || existing.policyId!==input.policy.id) return { status: "denied", reason: "conflict" };
    return { status: existing.status, created: false };
  }
  const { account, totals, snapshot } = await state(ctx,input);
  const denied = refusal(snapshot,input); if (denied) return denied;
  if (account) await ctx.db.patch(account._id,{ active: account.active+1 });
  else await ctx.db.insert("budgetAccounts",{ tenant: input.tenant, subject: input.subject, active: 1 });
  if (totals) await ctx.db.patch(totals._id,{ reservedMicros: totals.reservedMicros+input.estimateMicros });
  else await ctx.db.insert("budgetDays",{ tenant: input.tenant, subject: input.subject, day: snapshot.day, reservedMicros: input.estimateMicros, chargedMicros: 0, unknownCosts: 0 });
  await ctx.db.insert("budgetReservations",{ tenant: input.tenant, subject: input.subject, operationId: input.operationId, requestHash: input.requestHash, policyId: input.policy.id, estimateMicros: input.estimateMicros, day: snapshot.day, createdAt: input.now, status: "reserved", actualMicros: null });
  return { status: "reserved", created: true };
} });
export const settle = internalMutation({ args: { input: v.any() }, handler: async (ctx,args) => {
  const input = settlement.parse(args.input);
  const row = await ctx.db.query("budgetReservations").withIndex("by_operation", q => q.eq("operationId",input.operationId)).unique();
  if (!row || row.tenant!==input.tenant || row.subject!==input.subject) return false;
  if (row.status==="settled") return row.actualMicros===input.actualMicros;
  const account = await ctx.db.query("budgetAccounts").withIndex("by_owner",q => q.eq("tenant",input.tenant).eq("subject",input.subject)).unique();
  const totals = await ctx.db.query("budgetDays").withIndex("by_owner_day",q => q.eq("tenant",input.tenant).eq("subject",input.subject).eq("day",row.day)).unique();
  if (!account || !totals || account.active<1 || totals.reservedMicros<row.estimateMicros) throw new Error("Budget ledger invariant failed.");
  await ctx.db.patch(account._id,{ active: account.active-1 });
  await ctx.db.patch(totals._id,{ reservedMicros: totals.reservedMicros-row.estimateMicros, chargedMicros: totals.chargedMicros+(input.actualMicros ?? row.estimateMicros), unknownCosts: totals.unknownCosts+(input.actualMicros===null ? 1 : 0) });
  await ctx.db.patch(row._id,{ status: "settled", actualMicros: input.actualMicros });
  return true;
} });
export const correctSettlement = internalMutation({ args: { input: v.any() }, handler: async (ctx,args) => {
  const input = settlementCorrection.parse(args.input);
  const existing = await ctx.db.query("budgetCorrections").withIndex("by_correction",q => q.eq("correctionId",input.correctionId)).unique();
  if (existing) return existing.operationId===input.operationId && existing.tenant===input.tenant && existing.subject===input.subject &&
    existing.previousActualMicros===input.expectedActualMicros && existing.correctedActualMicros===input.correctedActualMicros &&
    existing.actor===input.actor && existing.reason===input.reason && existing.evidenceRef===input.evidenceRef
    ? "already_applied" : "conflict";
  const row = await ctx.db.query("budgetReservations").withIndex("by_operation",q => q.eq("operationId",input.operationId)).unique();
  if (!row || row.tenant!==input.tenant || row.subject!==input.subject) return "not_found";
  if (row.status!=="settled" || row.actualMicros!==input.expectedActualMicros || row.actualMicros===input.correctedActualMicros) return "conflict";
  const totals = await ctx.db.query("budgetDays").withIndex("by_owner_day",q => q.eq("tenant",input.tenant).eq("subject",input.subject).eq("day",row.day)).unique();
  if (!totals) throw new Error("Budget ledger invariant failed.");
  const chargedMicros = totals.chargedMicros - (row.actualMicros ?? row.estimateMicros) + input.correctedActualMicros;
  const unknownCosts = totals.unknownCosts - (row.actualMicros === null ? 1 : 0);
  if (!Number.isSafeInteger(chargedMicros) || chargedMicros < 0 || unknownCosts < 0) throw new Error("Budget correction exceeds the ledger range.");
  await ctx.db.patch(totals._id,{ chargedMicros,unknownCosts });
  await ctx.db.patch(row._id,{ actualMicros: input.correctedActualMicros });
  await ctx.db.insert("budgetCorrections",{ correctionId: input.correctionId,operationId: input.operationId,tenant: input.tenant,
    subject: input.subject,previousActualMicros: input.expectedActualMicros,correctedActualMicros: input.correctedActualMicros,
    actor: input.actor,reason: input.reason,evidenceRef: input.evidenceRef,at: Date.now() });
  return "applied";
} });
export const listCorrections = internalQuery({ args: { input: v.any() }, handler: async (ctx,args) => {
  const input = attemptOwner.parse(args.input);
  const rows = await ctx.db.query("budgetCorrections").withIndex("by_operation_time",q => q.eq("operationId",input.operationId)).order("desc").take(100);
  return rows.filter(row => row.tenant===input.tenant && row.subject===input.subject).map(row => correctionEntry.parse({
    correctionId: row.correctionId,operationId: row.operationId,tenant: row.tenant,subject: row.subject,
    previousActualMicros: row.previousActualMicros,correctedActualMicros: row.correctedActualMicros,
    actor: row.actor,reason: row.reason,evidenceRef: row.evidenceRef,at: row.at }));
} });
export const snapshot = internalQuery({ args: { input: v.any() }, handler: async (ctx,args) => (await state(ctx,lookup.parse(args.input))).snapshot });
export const getReservation = internalQuery({ args: { input: v.any() }, handler: async (ctx,args) => {
  const input = attemptOwner.parse(args.input);
  const row = await ctx.db.query("budgetReservations").withIndex("by_operation",q => q.eq("operationId",input.operationId)).unique();
  return row && row.tenant===input.tenant && row.subject===input.subject ? { requestHash: row.requestHash,status: row.status } : null;
} });
export const inspectReservation = internalQuery({ args: { input: v.any() }, handler: async (ctx,args) => {
  const input = attemptOwner.parse(args.input);
  const row = await ctx.db.query("budgetReservations").withIndex("by_operation",q => q.eq("operationId",input.operationId)).unique();
  return row && row.tenant===input.tenant && row.subject===input.subject
    ? { status: row.status,estimateMicros: row.estimateMicros,actualMicros: row.actualMicros,day: row.day,policyId: row.policyId } : null;
} });
export const listOutstanding = internalQuery({ args: { input: v.any() }, handler: async (ctx,args) => {
  const input = outstandingOptions.parse(args.input);
  const [time,id] = input.cursor?.split(".") ?? [];
  const rows = time === undefined
    ? await ctx.db.query("budgetReservations").withIndex("by_status_time",q => q.eq("status","reserved")).take(input.limit+1)
    : [
      ...await ctx.db.query("budgetReservations").withIndex("by_status_time",q => q.eq("status","reserved").eq("createdAt",Number(time)).gt("operationId",id!)).take(input.limit+1),
      ...await ctx.db.query("budgetReservations").withIndex("by_status_time",q => q.eq("status","reserved").gt("createdAt",Number(time))).take(input.limit+1),
    ].slice(0,input.limit+1);
  return pageOfOutstanding(rows.map(row => outstandingEntry.parse({ tenant: row.tenant,subject: row.subject,operationId: row.operationId,
    createdAt: row.createdAt,estimateMicros: row.estimateMicros,policyId: row.policyId })),input.limit);
} });
export const claimAttempt = internalMutation({ args: { input: v.any() }, handler: async (ctx,args) => {
  const input = attempt.parse(args.input);
  const row = await ctx.db.query("budgetReservations").withIndex("by_operation",q => q.eq("operationId",input.operationId)).unique();
  if (!row || row.tenant!==input.tenant || row.subject!==input.subject || row.status!=="reserved") return false;
  const existing = await ctx.db.query("budgetAttempts").withIndex("by_operation_attempt",q => q.eq("operationId",input.operationId).eq("attemptId",input.attemptId)).unique();
  if (existing) return true;
  const attempts = await ctx.db.query("budgetAttempts").withIndex("by_operation_attempt",q => q.eq("operationId",input.operationId)).take(input.maxAttempts);
  if (attempts.length >= input.maxAttempts) return false;
  await ctx.db.insert("budgetAttempts",{ operationId: input.operationId, attemptId: input.attemptId });
  return true;
} });
export const attemptCount = internalQuery({ args: { input: v.any() }, handler: async (ctx,args) => {
  const input = attemptOwner.parse(args.input);
  const row = await ctx.db.query("budgetReservations").withIndex("by_operation",q => q.eq("operationId",input.operationId)).unique();
  if (!row || row.tenant!==input.tenant || row.subject!==input.subject) return 0;
  return (await ctx.db.query("budgetAttempts").withIndex("by_operation_attempt",q => q.eq("operationId",input.operationId)).take(1000)).length;
} });
