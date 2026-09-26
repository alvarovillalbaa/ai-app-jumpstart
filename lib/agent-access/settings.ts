import { authSettings } from "../auth/settings";
import { parseRuntimeBudgetSettings } from "../budgets/runtime";
import { AppError } from "../http/errors";
import { checkedSettings } from "./signing";
import { trustedHttpOrigin } from "../security/origin";

/** Read at request time in both services. Never serialize this object to React. */
export function chatSettings(env: NodeJS.ProcessEnv = process.env) {
  if (!env.AI_CHAT_ENABLED || env.AI_CHAT_ENABLED === "false") return null;
  try {
    if (env.AI_CHAT_ENABLED !== "true") throw new Error("Invalid flag");
    const auth = authSettings(env);
    if (!auth) throw new Error("Registered user authentication is required");
    const signing = checkedSettings(JSON.parse(env.AI_CREATION_SIGNING_JSON ?? ""));
    const budget = parseRuntimeBudgetSettings(JSON.parse(env.AI_BUDGET_POLICY_JSON ?? ""));
    const origin = trustedHttpOrigin(env.AI_RUNTIME_ORIGIN);
    if (!origin) throw new Error("Invalid runtime origin");
    return { auth, signing, budget, origin };
  } catch {
    throw new AppError(503, "chat_unconfigured", "Chat configuration is unavailable. Contact the application operator.");
  }
}

export function requireChatSettings() {
  const settings = chatSettings();
  if (!settings) throw new AppError(503, "chat_disabled", "Chat is not enabled on this deployment.");
  return settings;
}
