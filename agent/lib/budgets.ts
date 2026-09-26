import { defineState } from "eve/context";
import { getBudgetStore } from "../../lib/budgets/store";
import { getSessionAccessStore } from "../../lib/agent-access/store";
import { RuntimeBudgets, readRuntimeBudgetSettings, type RuntimeBudgetState } from "../../lib/budgets/runtime";
const state = defineState<RuntimeBudgetState>("jumpstart.runtime-budget.v1", () => ({ turn: null, compaction: null }));
export async function runtimeBudgets() {
  return new RuntimeBudgets(await getBudgetStore(),await getSessionAccessStore(),state,readRuntimeBudgetSettings());
}
