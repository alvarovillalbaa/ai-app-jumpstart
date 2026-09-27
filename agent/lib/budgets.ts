import { defineState } from "eve/context";
import { getBudgetStore } from "../../lib/budgets/store";
import { getSessionAccessStore } from "../../lib/agent-access/store";
import { RuntimeBudgets, readRuntimeBudgetSettings, type RuntimeBudgetState } from "../../lib/budgets/runtime";
import type { ModelParams } from "../../lib/budgets/input";
const state = defineState<RuntimeBudgetState>("jumpstart.runtime-budget.v1", () => ({ turn: null, compaction: null }));
export async function runtimeBudgets() {
  return new RuntimeBudgets(await getBudgetStore(),await getSessionAccessStore(),state,readRuntimeBudgetSettings());
}
export async function prepareRuntimeModelCall(modelId: string,provider: string,params: ModelParams) {
  // Local-development/eval sessions have no application-owned budget. Owned
  // turns and manual compaction set this flag before reaching the model.
  if (!state.get().enforced) return undefined;
  return (await runtimeBudgets()).prepareProviderCall(modelId,provider,params);
}
