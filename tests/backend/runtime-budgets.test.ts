import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { RuntimeBudgets, type RuntimeBudgetState } from "../../lib/budgets/runtime";
const owner = { tenant: "test", subject: "alice" };
let access: ReturnType<typeof sqliteAccessStore>, budgets: ReturnType<typeof sqliteBudgetStore>, state: RuntimeBudgetState, runtime: RuntimeBudgets, operation: string;
const settings = { policy: { id: "fixture", dailyMicros: 200, maxActive: 1, maxPerMinute: 10 }, estimateMicros: 100, maxModelCalls: 2, modelIds: ["fixture"] };
function context(sequence = 0, id = `turn-${sequence}`) {
  const auth = { authenticator: "jumpstart", principalType: "user", principalId: owner.subject, issuer: owner.tenant, attributes: { creationOperationId: operation } };
  return { session: { id: "session", turn: { id, sequence }, auth: { current: auth, initiator: auth } } };
}
beforeEach(async () => {
  access = sqliteAccessStore(":memory:"); budgets = sqliteBudgetStore(":memory:"); operation = randomUUID(); state = { turn: null, compaction: null };
  await access.reserve({ ...owner, id: randomUUID(), operationId: operation, requestHash: "a".repeat(64) }); await access.bind(owner,operation,"session");
  runtime = new RuntimeBudgets(budgets,access,{ get: () => state, update: fn => { state = fn(state); } },settings);
});
afterEach(async () => { await access.close(); await budgets.close(); });
it("settles complete known usage and independently admits a follow-up", async () => {
  await runtime.beginTurn(context()); await runtime.beginStep(context(),"event-1","fixture"); runtime.completeStep(0.00001); await runtime.endTurn(context());
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 10, active: 0, unknownCosts: 0 });
  await runtime.beginTurn(context(1)); expect(state.turn?.operationId).not.toBe(operation);
  await runtime.beginStep(context(1),"event-2","fixture"); runtime.completeStep(undefined); await runtime.endTurn(context(1));
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 110, active: 0, unknownCosts: 1 });
  await expect(runtime.beginTurn(context(2))).rejects.toThrow("daily_limit");
});
it("admits a synthetic approval continuation once without turn.started", async () => {
  await runtime.beginTurn(context()); await runtime.beginStep(context(),"original","fixture"); runtime.completeStep(0.00001); await runtime.endTurn(context());
  const continuation = context(1);
  await runtime.beginStep(continuation,"resumed-1","fixture",1); runtime.completeStep(0.00001);
  await runtime.beginStep(continuation,"resumed-2","fixture"); runtime.completeStep(0.00001);
  await runtime.endTurn(continuation);
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ chargedMicros: 30,active: 0,unknownCosts: 0 });
  await expect(runtime.beginStep(continuation,"replayed-after-settlement","fixture",1)).rejects.toThrow("settled");
  await runtime.beginStep(context(2),"later-continuation","fixture",2); runtime.completeStep(0.00001); await runtime.endTurn(context(2));
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ chargedMicros: 40,active: 0,unknownCosts: 0 });
  await expect(runtime.beginStep(context(3),"missing-turn-start","fixture")).rejects.toThrow("No admitted turn budget");
  await expect(runtime.beginStep(context(3),"wrong-continuation-sequence","fixture",2)).rejects.toThrow("No admitted turn budget");
});
it("enforces the durable model call cap across distinct retries", async () => {
  await runtime.beginTurn(context()); await runtime.beginStep(context(),"event-1","fixture");
  await runtime.beginStep(context(),"event-2","fixture");
  await expect(runtime.beginStep(context(),"event-3","fixture")).rejects.toThrow("exhausted");
  await runtime.endTurn(context());
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 100, unknownCosts: 1, active: 0 });
});
it("does not refund a provider attempt lost from restored runtime state", async () => {
  await runtime.beginTurn(context()); const restored = structuredClone(state);
  await runtime.beginStep(context(),"crashed-attempt","fixture"); state = restored;
  await runtime.beginStep(context(),"retry","fixture"); runtime.completeStep(0.00001); await runtime.endTurn(context());
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 100, unknownCosts: 1 });
});
it("admits manual compaction separately and accounts automatic compaction inside a turn", async () => {
  await runtime.beginTurn(context()); await runtime.beginCompaction(context(),"auto","fixture"); await runtime.endCompaction(context());
  await runtime.beginStep(context(),"step","fixture"); runtime.completeStep(0.00001); await runtime.endTurn(context());
  await runtime.beginCompaction(context(),"manual","fixture"); await runtime.endCompaction(context());
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ chargedMicros: 200, unknownCosts: 2, active: 0 });
  await expect(runtime.beginCompaction(context(),"denied","fixture")).rejects.toThrow("daily_limit");
});
it("rejects unpriced models and retains partial overages for reconciliation", async () => {
  await runtime.beginTurn(context()); await expect(runtime.beginStep(context(),"unpriced","other")).rejects.toThrow("outside");
  await runtime.beginStep(context(),"known","fixture"); runtime.completeStep(0.00015);
  await runtime.beginStep(context(),"unknown","fixture");
  await expect(runtime.endTurn(context())).rejects.toThrow("reconciliation");
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ active: 1, reservedMicros: 100 });
});
it("does not convert an unrepresentable provider charge into an estimated settlement", async () => {
  await runtime.beginTurn(context()); await runtime.beginStep(context(),"oversized-charge","fixture");
  expect(() => runtime.completeStep(2_000_000)).toThrow("reconciliation");
  await expect(runtime.endTurn(context())).rejects.toThrow("reconciliation");
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ active: 1, reservedMicros: 100, chargedMicros: 0 });
});
it("does not widen an admitted turn when deployment call limits increase", async () => {
  await runtime.beginTurn(context());
  const changed = new RuntimeBudgets(budgets,access,{ get: () => state, update: fn => { state = fn(state); } },{ ...settings, maxModelCalls: 100 });
  await changed.beginStep(context(),"one","fixture"); await changed.beginStep(context(),"two","fixture");
  await expect(changed.beginStep(context(),"three","fixture")).rejects.toThrow("exhausted");
});
