import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { RuntimeBudgets, runtimeReservationPolicy, type RuntimeBudgetState } from "../../lib/budgets/runtime";
const owner = { tenant: "test", subject: "alice" };
let access: ReturnType<typeof sqliteAccessStore>, budgets: ReturnType<typeof sqliteBudgetStore>, state: RuntimeBudgetState, runtime: RuntimeBudgets, operation: string;
const freshReviewAt = new Date().toISOString().slice(0, 10);
const settings = { policy: { id: "fixture", dailyMicros: 200, maxActive: 1, maxPerMinute: 10 }, estimateMicros: 100, maxModelCalls: 2, modelIds: ["fixture"],
  costBasis: { sourceUrl: "https://example.test/fixture-prices", reviewedAt: freshReviewAt, maxOtherMicros: 0,
    models: [{ id: "fixture", maxInputTokens: 1, maxOutputTokens: 1, inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 }] } };
function context(sequence = 0, id = `turn-${sequence}`) {
  const auth = { authenticator: "jumpstart", principalType: "user", principalId: owner.subject, issuer: owner.tenant, attributes: { creationOperationId: operation } };
  return { session: { id: "session", turn: { id, sequence }, auth: { current: auth, initiator: auth } } };
}
async function step(ctx: ReturnType<typeof context>, eventId: string, modelId: string, sequence?: number, controller = runtime) {
  await controller.beginStep(ctx,eventId,modelId,sequence);
  return controller.prepareProviderCall(modelId,"fixture-provider",{ prompt: [] });
}
async function compact(ctx: ReturnType<typeof context>, eventId: string, modelId: string) {
  await runtime.beginCompaction(ctx,eventId,modelId);
  return runtime.prepareProviderCall(modelId,"fixture-provider",{ prompt: [] });
}
beforeEach(async () => {
  access = sqliteAccessStore(":memory:"); budgets = sqliteBudgetStore(":memory:"); operation = randomUUID(); state = { turn: null, compaction: null };
  await access.reserve({ ...owner, id: randomUUID(), operationId: operation, requestHash: "a".repeat(64) }); await access.bind(owner,operation,"session");
  runtime = new RuntimeBudgets(budgets,access,{ get: () => state, update: fn => { state = fn(state); } },settings);
});
afterEach(async () => { await access.close(); await budgets.close(); });
it("blocks stale admission and settles an unstarted first-turn reservation at zero", async () => {
  await budgets.reserve({ ...owner,operationId: operation,requestHash: "a".repeat(64),estimateMicros: settings.estimateMicros,
    policy: runtimeReservationPolicy(settings),now: Date.parse("2026-10-01T12:00:00Z") });
  const stale = new RuntimeBudgets(budgets,access,{ get: () => state, update: fn => { state = fn(state); } },
    { ...settings,costBasis: { ...settings.costBasis,reviewedAt: "2026-08-31" } },() => Date.parse("2026-10-01T12:00:00Z"));
  await expect(stale.beginTurn(context())).rejects.toThrow("older than 30 UTC days");
  await expect(stale.beginCompaction(context(),"manual","fixture")).rejects.toThrow("older than 30 UTC days");
  expect(await budgets.snapshot({ ...owner,now: Date.parse("2026-10-01T12:00:00Z") })).toMatchObject({ active: 0,reservedMicros: 0,chargedMicros: 0 });
});
it("rechecks review age at the provider boundary before claiming a billed attempt", async () => {
  let now = Date.parse("2026-10-01T12:00:00Z");
  const atBoundary = new RuntimeBudgets(budgets,access,{ get: () => state, update: fn => { state = fn(state); } },
    { ...settings,costBasis: { ...settings.costBasis,reviewedAt: "2026-09-01" } },() => now);
  await atBoundary.beginTurn(context());
  await atBoundary.beginStep(context(),"expires-before-provider","fixture");
  now = Date.parse("2026-10-02T00:00:00Z");
  await expect(atBoundary.prepareProviderCall("fixture","fixture-provider",{ prompt: [] })).rejects.toThrow("older than 30 UTC days");
  expect(await budgets.attemptCount({ ...owner,operationId: operation })).toBe(0);
});
it("settles complete known usage and independently admits a follow-up", async () => {
  await runtime.beginTurn(context()); await step(context(),"event-1","fixture"); runtime.completeStep(0.00001); await runtime.endTurn(context());
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 10, active: 0, unknownCosts: 0 });
  await runtime.beginTurn(context(1)); expect(state.turn?.operationId).not.toBe(operation);
  await step(context(1),"event-2","fixture"); runtime.completeStep(undefined); await runtime.endTurn(context(1));
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 110, active: 0, unknownCosts: 1 });
  await expect(runtime.beginTurn(context(2))).rejects.toThrow("daily_limit");
});
it("admits a synthetic approval continuation once without turn.started", async () => {
  await runtime.beginTurn(context()); await step(context(),"original","fixture"); runtime.completeStep(0.00001); await runtime.endTurn(context());
  const continuation = context(1);
  await step(continuation,"resumed-1","fixture",1); runtime.completeStep(0.00001);
  await step(continuation,"resumed-2","fixture"); runtime.completeStep(0.00001);
  await runtime.endTurn(continuation);
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ chargedMicros: 30,active: 0,unknownCosts: 0 });
  await expect(step(continuation,"replayed-after-settlement","fixture",1)).rejects.toThrow("settled");
  await step(context(2),"later-continuation","fixture",2); runtime.completeStep(0.00001); await runtime.endTurn(context(2));
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ chargedMicros: 40,active: 0,unknownCosts: 0 });
  await expect(step(context(3),"missing-turn-start","fixture")).rejects.toThrow("No admitted turn budget");
  await expect(step(context(3),"wrong-continuation-sequence","fixture",2)).rejects.toThrow("No admitted turn budget");
});
it("enforces the durable model call cap across distinct retries", async () => {
  await runtime.beginTurn(context()); await step(context(),"event-1","fixture");
  await step(context(),"event-2","fixture");
  await expect(step(context(),"event-3","fixture")).rejects.toThrow("exhausted");
  await runtime.endTurn(context());
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 100, unknownCosts: 1, active: 0 });
});
it("does not refund a provider attempt lost from restored runtime state", async () => {
  await runtime.beginTurn(context()); const restored = structuredClone(state);
  await step(context(),"crashed-attempt","fixture"); state = restored;
  await step(context(),"retry","fixture"); runtime.completeStep(0.00001); await runtime.endTurn(context());
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 100, unknownCosts: 1 });
});
it("admits manual compaction separately and accounts automatic compaction inside a turn", async () => {
  await runtime.beginTurn(context()); await compact(context(),"auto","fixture"); await runtime.endCompaction(context());
  await step(context(),"step","fixture"); runtime.completeStep(0.00001); await runtime.endTurn(context());
  await compact(context(),"manual","fixture"); await runtime.endCompaction(context());
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 200, unknownCosts: 2, active: 0 });
  await expect(compact(context(),"denied","fixture")).rejects.toThrow("daily_limit");
});
it("rejects unpriced models and retains partial overages for reconciliation", async () => {
  await runtime.beginTurn(context()); await expect(step(context(),"unpriced","other")).rejects.toThrow("outside");
  await step(context(),"known","fixture"); runtime.completeStep(0.00015);
  await step(context(),"unknown","fixture");
  await expect(runtime.endTurn(context())).rejects.toThrow("reconciliation");
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ active: 1, reservedMicros: 100 });
});
it("does not convert an unrepresentable provider charge into an estimated settlement", async () => {
  await runtime.beginTurn(context()); await step(context(),"oversized-charge","fixture");
  expect(() => runtime.completeStep(2_000_000)).toThrow("reconciliation");
  await expect(runtime.endTurn(context())).rejects.toThrow("reconciliation");
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ active: 1, reservedMicros: 100, chargedMicros: 0 });
});
it("does not widen an admitted turn when deployment call limits increase", async () => {
  await runtime.beginTurn(context());
  const changed = new RuntimeBudgets(budgets,access,{ get: () => state, update: fn => { state = fn(state); } },{ ...settings, maxModelCalls: 100 });
  await step(context(),"one","fixture",undefined,changed); await step(context(),"two","fixture",undefined,changed);
  await expect(step(context(),"three","fixture",undefined,changed)).rejects.toThrow("exhausted");
});
