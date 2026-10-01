import { defineInstrumentation } from "eve/instrumentation";
import type { InstrumentationEvent,ProviderContext,ProviderEvents } from "eve/instrumentation";
import { z } from "zod";
import { consoleAuditSink,emitAudit,runtimeReference,type AuditSink } from "./runtime";

const reference = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z.object({ operationRef: reference,startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  modelRef: reference.optional(),providerRef: reference.optional(),toolRef: reference.optional(),callRef: reference.optional() }).strict();
export const metadataOnly = () => ({ emit: true,recordInputs: false,recordOutputs: false });
const count = (value: number | undefined) => typeof value === "number" && Number.isSafeInteger(value) && value>=0 ? value : null;

/** Native operation-scoped state survives suspension; no process-wide session map. */
export function runtimeAuditProvider(sink: AuditSink = consoleAuditSink,clock = Date.now) {
  function observe(event: InstrumentationEvent,ctx: ProviderContext) {
    try {
      const operationRef = runtimeReference(event.idempotencyKey),now = clock();
      const previous = stateSchema.safeParse(ctx.state.get());
      let saved = previous.success && previous.data.operationRef === operationRef ? previous.data : undefined;
      if (event.type.endsWith(".started") || event.type === "input.requested") {
        saved = { operationRef,startedAt: saved?.startedAt ?? now,
          ...("model" in event ? { modelRef: runtimeReference(event.model.modelId),providerRef: runtimeReference(event.model.provider) } : {}),
          ...("operation" in event ? { modelRef: runtimeReference(event.operation.modelId),providerRef: runtimeReference(event.operation.provider) } : {}),
          ...(event.type === "action.started" ? { toolRef: runtimeReference(event.name),callRef: runtimeReference(event.callId) } : {}),
          ...(event.type === "input.requested" ? { toolRef: runtimeReference(event.action.name),callRef: runtimeReference(event.action.callId) } : {}) };
        ctx.state.set(saved);
      }
      const scope = "scope" in event ? event.scope : event;
      const terminal = /\.(completed|failed|cancelled)$/.test(event.type) || event.type === "input.resolved";
      const durationMs = terminal && saved && Number.isFinite(now) ? Math.max(0,Math.floor(now-saved.startedAt)) : null;
      const usage = "usage" in event ? event.usage : undefined;
      emitAudit({ event: "runtime_lifecycle",schemaVersion: 1,at: count(now),phase: event.type,operationRef,
        ...("sessionId" in scope ? { sessionRef: runtimeReference(scope.sessionId) } : {}),
        ...("turnId" in scope && scope.turnId ? { turnRef: runtimeReference(scope.turnId) } : {}),
        ...("attemptId" in scope ? { attemptRef: runtimeReference(scope.attemptId),attemptIndex: count(scope.attemptIndex),stepIndex: count(scope.stepIndex) } : {}),
        ...(saved?.modelRef ? { modelRef: saved.modelRef,providerRef: saved.providerRef } : {}),
        ...(saved?.toolRef ? { toolRef: saved.toolRef,callRef: saved.callRef } : {}),
        durationMs,
        ...(event.type === "action.completed" ? { outcome: event.output.type === "error" ? "failed" : "completed" } :
          "outcome" in event ? { outcome: event.outcome } : terminal ? { outcome: event.type.endsWith("failed") ? "failed" : event.type.endsWith("cancelled") ? "cancelled" : "completed" } : {}),
        ...(event.type === "model.call.completed" ? { inputTokens: count(usage?.inputTokens),outputTokens: count(usage?.outputTokens),
          cacheReadTokens: count(usage?.inputTokenDetails?.cacheReadTokens),cacheWriteTokens: count(usage?.inputTokenDetails?.cacheWriteTokens) } : {}) },sink);
    } catch { /* Instrumentation must not alter authorization, billing or execution. */ }
  }
  const names = ["session.started","session.waiting","session.completed","session.failed","turn.started","turn.completed","turn.failed","turn.cancelled",
    "step.attempt.started","step.attempt.completed","step.attempt.failed","model.call.started","model.call.completed","model.call.failed",
    "action.started","action.completed","action.failed","input.requested","input.resolved","channel.delivery.started","channel.delivery.completed","channel.delivery.failed","channel.delivery.cancelled"] as const;
  const events: ProviderEvents = Object.fromEntries(names.map(name => [name,observe]));
  return defineInstrumentation({ tracePolicy: metadataOnly,events });
}
