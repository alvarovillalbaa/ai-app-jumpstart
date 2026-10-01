import { defineState } from "eve/context";
import { getBudgetStore } from "../../lib/budgets/store";
import { getSessionAccessStore } from "../../lib/agent-access/store";
import { RuntimeBudgets, readRuntimeBudgetSettings, type RuntimeBudgetState } from "../../lib/budgets/runtime";
import type { ModelParams } from "../../lib/budgets/input";
import { consoleAuditSink, runtimeReference } from "../../lib/observability/runtime";
const state = defineState<RuntimeBudgetState>("jumpstart.runtime-budget.v1", () => ({ turn: null, compaction: null }));
export async function runtimeBudgets() {
  return new RuntimeBudgets(await getBudgetStore(),await getSessionAccessStore(),state,readRuntimeBudgetSettings(),Date.now,consoleAuditSink);
}
export async function prepareRuntimeModelCall(modelId: string,provider: string,params: ModelParams) {
  // Local-development/eval sessions have no application-owned budget. Owned
  // turns and manual compaction set this flag before reaching the model.
  if (!state.get().enforced) return undefined;
  return (await runtimeBudgets()).prepareProviderCall(modelId,provider,params);
}
export function runtimeBudgetReservationReference(turnId: string) {
  const saved = state.get();
  const run = saved.turn?.open && saved.turn.turnId === turnId ? saved.turn :
    saved.compaction?.open && saved.compaction.turnId === turnId ? saved.compaction : null;
  return run ? runtimeReference(run.operationId) : undefined;
}
