import { BudgetedCreation } from "../budgets/creation";
import { getBudgetStore } from "../budgets/store";
import { ConversationBroker, creationTransport } from "./broker";
import { getSessionAccessStore } from "./store";
import { requireChatSettings } from "./settings";
import { cancelPendingStart } from "./cancel-start";

export async function chatApplication(settings: ReturnType<typeof requireChatSettings>) {
  const [access, budgets] = await Promise.all([getSessionAccessStore(), getBudgetStore()]);
  const broker = new ConversationBroker(access, creationTransport(settings.origin, settings.signing));
  return { broker, budgets, creation: new BudgetedCreation(broker, budgets, settings.budget.policy, () => settings.budget.estimateMicros),
    cancelStart: (owner: Parameters<typeof cancelPendingStart>[2], operation: string) => cancelPendingStart(access,budgets,owner,operation) };
}
