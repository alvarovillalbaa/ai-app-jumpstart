import { z } from "zod";
import { accessOwner, bodyHash, operationId } from "../agent-access/contract";

// Integer micro-USD avoids floating point currency arithmetic. Prices/limits are
// trusted server inputs; no browser may set them or report its own actual usage.
export const micros = z.number().int().min(0).max(1_000_000_000_000);
export const budgetPolicy = z.object({
  id: z.string().min(1).max(100), dailyMicros: micros.positive(),
  maxActive: z.number().int().min(1).max(1000), maxPerMinute: z.number().int().min(1).max(1000),
}).strict();
export const admission = accessOwner.extend({ operationId, requestHash: bodyHash, estimateMicros: micros.positive(), policy: budgetPolicy, now: z.number().int().positive().max(8_640_000_000_000_000) }).strict();
export const settlement = accessOwner.extend({ operationId, actualMicros: micros.nullable() }).strict();
export const settlementCorrection = accessOwner.extend({
  operationId, correctionId: operationId,
  expectedActualMicros: micros.nullable(), correctedActualMicros: micros,
  actor: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(10).max(1000),
  evidenceRef: z.string().trim().min(1).max(500),
}).strict();
export const correctionResult = z.enum(["applied", "already_applied", "conflict", "not_found"]);
export const correctionEntry = settlementCorrection.extend({ previousActualMicros: micros.nullable(),at: z.number().int().positive() })
  .omit({ expectedActualMicros: true }).strict();
export const lookup = accessOwner.extend({ now: admission.shape.now }).strict();
export const attemptOwner = accessOwner.extend({ operationId }).strict();
export const reservationState = z.object({ requestHash: bodyHash, status: z.enum(["reserved", "settled"]) }).strict();
export const budgetInspection = z.object({ status: z.enum(["reserved", "settled"]),estimateMicros: micros.positive(),
  actualMicros: micros.nullable(),day: z.number().int().nonnegative(),policyId: z.string().min(1).max(100) }).strict();
export type ReservationState = z.infer<typeof reservationState>;
export const outstandingCursor = z.string().regex(/^[0-9]{1,16}\.[a-f0-9-]{36}$/).refine(value => {
  const [time,id] = value.split("."); return Number.isSafeInteger(Number(time)) && operationId.safeParse(id).success;
});
export const outstandingOptions = z.object({ limit: z.number().int().min(1).max(100).default(50), cursor: outstandingCursor.optional() }).strict();
export type OutstandingOptions = z.input<typeof outstandingOptions>;
export const outstandingEntry = accessOwner.extend({ operationId,createdAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  estimateMicros: micros.positive(),policyId: z.string().min(1).max(100) }).strict();
export const outstandingPage = z.object({ items: z.array(outstandingEntry),nextCursor: outstandingCursor.nullable() }).strict();
export function pageOfOutstanding(rows: z.infer<typeof outstandingEntry>[],limit: number) {
  const items = rows.slice(0,limit), last = items.at(-1);
  return outstandingPage.parse({ items,nextCursor: rows.length > limit && last ? `${last.createdAt}.${last.operationId}` : null });
}
export const ledgerOptions = accessOwner.extend({ limit: z.number().int().min(1).max(100).default(50),cursor: outstandingCursor.optional() }).strict();
export const ledgerQueryOptions = ledgerOptions.omit({ tenant: true,subject: true });
export const ledgerEntry = z.object({ operationId,createdAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  day: z.number().int().nonnegative(),policyId: z.string().min(1).max(100),estimateMicros: micros.positive(),
  status: z.enum(["reserved","settled"]),actualMicros: micros.nullable() }).strict();
export const ledgerPage = z.object({ items: z.array(ledgerEntry),nextCursor: outstandingCursor.nullable() }).strict();
export function pageOfLedger(rows: z.infer<typeof ledgerEntry>[],limit: number) {
  const items = rows.slice(0,limit), last = items.at(-1);
  return ledgerPage.parse({ items,nextCursor: rows.length > limit && last ? `${last.createdAt}.${last.operationId}` : null });
}
export const attempt = attemptOwner.extend({ attemptId: bodyHash, maxAttempts: z.number().int().min(1).max(1000) }).strict();
export type Admission = z.infer<typeof admission>;
export type Settlement = z.infer<typeof settlement>;
export const admissionResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("reserved"), created: z.boolean() }).strict(),
  z.object({ status: z.literal("settled"), created: z.literal(false) }).strict(),
  z.object({ status: z.literal("denied"), reason: z.enum(["conflict", "daily_limit", "active_limit", "rate_limit"]) }).strict(),
]);
export type AdmissionResult = z.infer<typeof admissionResult>;
const total = z.number().int().nonnegative();
export const snapshot = z.object({ day: total, reservedMicros: total, chargedMicros: total, active: total, recent: total, unknownCosts: total }).strict();
export type BudgetSnapshot = z.infer<typeof snapshot>;
export interface BudgetStore {
  reserve(input: Admission): Promise<AdmissionResult>;
  getReservation(input: z.infer<typeof attemptOwner>): Promise<ReservationState | null>;
  inspectReservation(input: z.infer<typeof attemptOwner>): Promise<z.infer<typeof budgetInspection> | null>;
  listOutstanding(input: OutstandingOptions): Promise<z.infer<typeof outstandingPage>>;
  listLedger(input: z.input<typeof ledgerOptions>): Promise<z.infer<typeof ledgerPage>>;
  settle(input: Settlement): Promise<boolean>;
  correctSettlement(input: z.infer<typeof settlementCorrection>): Promise<z.infer<typeof correctionResult>>;
  listCorrections(input: z.infer<typeof attemptOwner>): Promise<z.infer<typeof correctionEntry>[]>;
  snapshot(input: z.infer<typeof lookup>): Promise<BudgetSnapshot>;
  claimAttempt(input: z.infer<typeof attempt>): Promise<boolean>;
  attemptCount(input: z.infer<typeof attemptOwner>): Promise<number>;
  close(): Promise<void>;
}
export const budgetCommand = z.discriminatedUnion("operation", [
  admission.extend({ operation: z.literal("budget.reserve") }),
  attemptOwner.extend({ operation: z.literal("budget.getReservation") }),
  attemptOwner.extend({ operation: z.literal("budget.inspectReservation") }),
  outstandingOptions.extend({ operation: z.literal("budget.listOutstanding") }),
  ledgerOptions.extend({ operation: z.literal("budget.listLedger") }),
  settlement.extend({ operation: z.literal("budget.settle") }),
  settlementCorrection.extend({ operation: z.literal("budget.correctSettlement") }),
  attemptOwner.extend({ operation: z.literal("budget.listCorrections") }),
  lookup.extend({ operation: z.literal("budget.snapshot") }),
  attempt.extend({ operation: z.literal("budget.claimAttempt") }),
  attemptOwner.extend({ operation: z.literal("budget.attemptCount") }),
]);
export const dayOf = (now: number) => Math.floor(now / 86_400_000);
export function refusal(state: BudgetSnapshot, input: Admission): AdmissionResult | null {
  if (state.chargedMicros + state.reservedMicros + input.estimateMicros > input.policy.dailyMicros) return { status: "denied", reason: "daily_limit" };
  if (state.active >= input.policy.maxActive) return { status: "denied", reason: "active_limit" };
  if (state.recent >= input.policy.maxPerMinute) return { status: "denied", reason: "rate_limit" };
  return null;
}
