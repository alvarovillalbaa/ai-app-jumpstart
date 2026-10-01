import { createHash } from "node:crypto";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";
import type { HookContext } from "eve/hooks";

/** Runtime/model-supplied identifiers are opaque references, never raw log text. */
export function runtimeReference(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
export type AuditSink = (record: Readonly<Record<string,unknown>>) => void;
export const consoleAuditSink: AuditSink = record => { console.info(JSON.stringify(record)); };
/** Logging is observational. A broken sink must not fail a turn or repeat work. */
export function emitAudit(record: Readonly<Record<string,unknown>>,sink: AuditSink = consoleAuditSink) {
  try { sink(record); } catch { /* No fallback exception text or private diagnostic. */ }
}
const uuid = z.uuid();
const sha256Reference = z.string().regex(/^[a-f0-9]{64}$/);
const tokenCount = (value: number | undefined) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
export function runtimeCreationReference(ctx: Pick<HookContext,"session">) {
  const auth = ctx.session.auth.initiator;
  if (auth?.authenticator !== "jumpstart") return {};
  const parsed = uuid.safeParse(auth.attributes.creationRequestId);
  return parsed.success ? { creationRequestId: parsed.data } : {};
}
/** Report cost separately: native model-call metadata does not contain USD. */
export function observeRuntimeStream(event: MessageStreamEvent,ctx: Pick<HookContext,"session">,sink: AuditSink = consoleAuditSink,reservationRef?: string) {
  if (ctx.session.auth.initiator?.authenticator !== "jumpstart" || event.type !== "step.completed") return;
  const usd = event.data.usage?.costUsd;
  const amount = typeof usd === "number" && Number.isFinite(usd) && usd>=0 ? Math.ceil(usd*1_000_000) : null;
  const costMicros = amount !== null && Number.isSafeInteger(amount) && amount<=1_000_000_000_000 ? amount : null;
  emitAudit({ event: "runtime_step_usage",schemaVersion: 1,at: Date.now(),...runtimeCreationReference(ctx),
    sessionRef: runtimeReference(ctx.session.id),turnRef: runtimeReference(event.data.turnId),eventRef: runtimeReference(event.meta.id),
    ...(sha256Reference.safeParse(reservationRef).success ? { reservationRef } : {}),
    costMicros,costSource: costMicros === null ? "unknown" : "runtime_reported" },sink);
}

export type RuntimeBudgetAttemptReference = {
  attemptRef: string;
  reservationRef: string;
  sessionRef: string;
  turnRef: string;
  stepRef: string;
  modelRef: string;
  providerRef: string;
  callKind: "step" | "compaction";
};
export type RuntimeBudgetAttemptPhase = "claimed" | "completed" | "failed" | "cancelled" | "incomplete";
/** Link provider usage to a durable ledger attempt without logging prompts or provider responses. */
export function observeRuntimeBudgetAttempt(reference: RuntimeBudgetAttemptReference,phase: RuntimeBudgetAttemptPhase,sink: AuditSink = consoleAuditSink,usage?: { inputTokens?: number; outputTokens?: number }) {
  emitAudit({ event: "runtime_budget_attempt",schemaVersion: 1,at: Date.now(),phase,...reference,
    ...(phase === "claimed" ? {} : { inputTokens: tokenCount(usage?.inputTokens),outputTokens: tokenCount(usage?.outputTokens) }) },sink);
}
