import { expect,it } from "vitest";
import type { InstrumentationEvent,ProviderContext,JsonValue } from "eve/instrumentation";
import { runtimeAuditProvider,metadataOnly } from "../../lib/observability/runtime-provider";
import { runtimeReference,observeRuntimeStream,observeRuntimeBudgetAttempt } from "../../lib/observability/runtime";
import type { MessageStreamEvent } from "eve/client";
import type { HookContext } from "eve/hooks";

const scope = { sessionId: "private-session",turnId: "private-turn",attemptId: "private-attempt",attemptIndex: 1,stepIndex: 2 };
function state(initial?: JsonValue) {
  let saved = initial;
  const ctx: ProviderContext = { state: { get: () => saved,set: value => { saved = value; } } };
  return ctx;
}
it("uses explicit metadata-only capture and emits hashes, reported zero tokens and unknown absent counts",async () => {
  const rows: Readonly<Record<string,unknown>>[] = [];let now = 100;
  const provider = runtimeAuditProvider(row => rows.push(row),() => now),ctx = state();
  expect(metadataOnly()).toEqual({ emit: true,recordInputs: false,recordOutputs: false });
  await provider.events!["model.call.started"]!({ type: "model.call.started",scope,idempotencyKey: "private-operation",
    model: { modelId: "private-model",provider: "private-provider" },input: { messages: ["private-prompt"] },runtimeContext: { bearer: "private-token" } },ctx);
  now = 145;
  await provider.events!["model.call.completed"]!({ type: "model.call.completed",scope,idempotencyKey: "private-operation",finishReason: "private-reason",
    responseId: "private-response",content: [{ type: "text",text: "private-output" }],usage: { inputTokens: 0,outputTokens: 7,inputTokenDetails: { cacheReadTokens: NaN } } },ctx);
  expect(rows[1]).toMatchObject({ at: 145,durationMs: 45,outcome: "completed",inputTokens: 0,outputTokens: 7,cacheReadTokens: null,cacheWriteTokens: null,
    modelRef: runtimeReference("private-model"),sessionRef: runtimeReference(scope.sessionId),operationRef: runtimeReference("private-operation") });
  expect(JSON.stringify(rows)).not.toContain("private-");
  expect(JSON.stringify(ctx.state.get())).not.toContain("private-");
});
it("restores operation timing, preserves replayed starts and tolerates missing starts or backwards clocks",async () => {
  const rows: Readonly<Record<string,unknown>>[] = [];let now = 100;
  const provider = runtimeAuditProvider(row => rows.push(row),() => now),ctx = state();
  const start = { type: "action.started",scope,idempotencyKey: "call-key",kind: "tool-call",name: "private-tool",callId: "private-call",input: { password: "private-input" } } as const;
  await provider.events!["action.started"]!(start,ctx);
  const restored = state(JSON.parse(JSON.stringify(ctx.state.get())));now = 200;
  await provider.events!["action.started"]!(start,restored);
  await provider.events!["action.completed"]!({ type: "action.completed",scope,idempotencyKey: "call-key",outcome: "completed",output: { type: "error",error: "private-error" } },restored);
  expect(rows.at(-1)).toMatchObject({ durationMs: 100,outcome: "failed",callRef: runtimeReference("private-call"),toolRef: runtimeReference("private-tool") });
  now = 50;
  await provider.events!["action.failed"]!({ type: "action.failed",scope,idempotencyKey: "call-key",outcome: "rejected",error: new Error("private-exception") },restored);
  expect(rows.at(-1)).toMatchObject({ durationMs: 0,outcome: "rejected" });
  await provider.events!["model.call.failed"]!({ type: "model.call.failed",scope,idempotencyKey: "missing",error: new Error("private-exception") },state());
  expect(rows.at(-1)).toMatchObject({ durationMs: null,outcome: "failed" });
  const approval = state();now = 1000;
  await provider.events!["input.requested"]!({ type: "input.requested",scope,idempotencyKey: "approval-key",kind: "tool-approval",
    requestId: "private-approval",action: { name: "private-tool",callId: "private-call" },request: { prompt: "private-prompt" } },approval);
  now = 2500;
  await provider.events!["input.resolved"]!({ type: "input.resolved",scope,idempotencyKey: "approval-key",kind: "tool-approval",
    requestId: "private-approval",outcome: "denied",response: { text: "private-response" } },state(JSON.parse(JSON.stringify(approval.state.get()))));
  expect(rows.at(-1)).toMatchObject({ durationMs: 1500,outcome: "denied",callRef: runtimeReference("private-call") });
  expect(JSON.stringify(rows)).not.toContain("private-");
});
it("never lets a sink or state failure alter runtime execution",async () => {
  const provider = runtimeAuditProvider(() => { throw new Error("private-exporter-error"); });
  const event = { type: "turn.started",sessionId: "session",rootSessionId: "session",turnId: "turn",sequence: 0,idempotencyKey: "turn-key" } as const;
  await expect(Promise.resolve(provider.events!["turn.started"]!(event,state()))).resolves.toBeUndefined();
  const broken: ProviderContext = { state: { get() { throw new Error("private-state-error"); },set() {} } };
  await expect(Promise.resolve(provider.events!["turn.started"]!(event,broken))).resolves.toBeUndefined();
});

it("does not forward corrupted persisted reference fields",async () => {
  const rows: Readonly<Record<string,unknown>>[] = [],key = "operation";
  const provider = runtimeAuditProvider(row => rows.push(row),() => 200);
  await provider.events!["model.call.failed"]!({ type: "model.call.failed",scope,idempotencyKey: key },
    state({ operationRef: runtimeReference(key),startedAt: 100,modelRef: "private-corrupt-reference" }));
  expect(rows[0]).toMatchObject({ durationMs: null,outcome: "failed" });
  expect(rows[0]).not.toHaveProperty("modelRef");expect(JSON.stringify(rows)).not.toContain("private-");
});
it("does not log principals, approval payloads, channel request IDs or arbitrary error codes",async () => {
  const rows: Readonly<Record<string,unknown>>[] = [],provider = runtimeAuditProvider(row => rows.push(row));
  const events = [
    { type: "turn.started",sessionId: "s",rootSessionId: "s",turnId: "t",sequence: 0,idempotencyKey: "t",currentPrincipal: { id: "private-user",type: "user" } },
    { type: "input.resolved",scope,idempotencyKey: "input",kind: "tool-approval",requestId: "private-request",outcome: "denied",response: { text: "private-response" },error: "private-error" },
    { type: "channel.delivery.failed",sessionId: "s",rootSessionId: "s",turnId: "t",delivery: { deliveryId: "private-delivery",channelKind: "private-channel",channelName: "private-name",requestId: "private-request" },idempotencyKey: "delivery",outcome: "failed",errorCode: "private-code",error: "private-error" },
  ] as InstrumentationEvent[];
  for (const event of events) await provider.events![event.type]!(event as never,state());
  expect(rows).toHaveLength(3);expect(JSON.stringify(rows)).not.toContain("private-");
});
it("reports runtime cost separately, keeps unavailable cost unknown and accepts only signed UUID correlation",() => {
  const rows: Readonly<Record<string,unknown>>[] = [];
  const ctx = { session: { id: "private-session",auth: { initiator: { authenticator: "jumpstart",attributes: { creationRequestId: "ac37acb6-08ba-4c9a-9c09-014e3f3b42ea" } } } } } as unknown as HookContext;
  for (const costUsd of [0,0.0000011,undefined,-1,NaN,Infinity,1e20]) {
    const event = { type: "step.completed",meta: { id: "private-event" },data: { turnId: "private-turn",usage: { costUsd },message: "private-message" } } as unknown as MessageStreamEvent;
    observeRuntimeStream(event,ctx,row => rows.push(row));
  }
  expect(rows.map(row => row.costMicros)).toEqual([0,2,null,null,null,null,null]);
  expect(rows[0]).toMatchObject({ creationRequestId: "ac37acb6-08ba-4c9a-9c09-014e3f3b42ea",costSource: "runtime_reported" });
  expect(rows[2]).toMatchObject({ costSource: "unknown" });expect(JSON.stringify(rows)).not.toContain("private-");
  const correlated = { type: "step.completed",meta: { id: "private-event" },data: { turnId: "private-turn",usage: { costUsd: 0 } } } as unknown as MessageStreamEvent;
  observeRuntimeStream(correlated,ctx,row => rows.push(row),runtimeReference("private-reservation"));
  observeRuntimeStream(correlated,ctx,row => rows.push(row),"private-unvalidated-reservation");
  expect(rows.at(-2)).toHaveProperty("reservationRef",runtimeReference("private-reservation"));
  expect(rows.at(-1)).not.toHaveProperty("reservationRef");
});
it("correlates provider attempt phases with hashed metadata and token counts without changing execution on sink failure",() => {
  const rows: Readonly<Record<string,unknown>>[] = [];
  const reference = { attemptRef: runtimeReference("private-attempt"),reservationRef: runtimeReference("private-reservation"),
    sessionRef: runtimeReference("private-session"),turnRef: runtimeReference("private-turn"),stepRef: runtimeReference("private-step"),
    modelRef: runtimeReference("private-model"),providerRef: runtimeReference("private-provider"),callKind: "step" as const };
  observeRuntimeBudgetAttempt(reference,"claimed",row => rows.push(row));
  observeRuntimeBudgetAttempt(reference,"completed",row => rows.push(row),{ inputTokens: 0,outputTokens: 8 });
  observeRuntimeBudgetAttempt(reference,"failed",row => rows.push(row),{ inputTokens: -1,outputTokens: undefined });
  expect(rows).toMatchObject([
    { event: "runtime_budget_attempt",phase: "claimed",...reference },
    { event: "runtime_budget_attempt",phase: "completed",...reference,inputTokens: 0,outputTokens: 8 },
    { event: "runtime_budget_attempt",phase: "failed",...reference,inputTokens: null,outputTokens: null },
  ]);
  expect(JSON.stringify(rows)).not.toMatch(/private-(attempt|reservation|session|turn|step|model|provider)/);
  expect(() => observeRuntimeBudgetAttempt(reference,"failed",() => { throw new Error("private sink error"); })).not.toThrow();
});
