import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { parseRuntimeBudgetSettings } from "../lib/budgets/runtime";
import { quotedEnvelopeMicros } from "../lib/budgets/cost-basis";

/** Offline review of the same account-chat policy parsed by Next and Eve. */
export function checkBudgetPolicy(env: NodeJS.ProcessEnv = process.env) {
  if (!env.AI_BUDGET_POLICY_JSON) throw new Error("Set AI_BUDGET_POLICY_JSON to a reviewed server-side policy.");
  let raw: unknown;
  try { raw = JSON.parse(env.AI_BUDGET_POLICY_JSON); }
  catch { throw new Error("AI_BUDGET_POLICY_JSON is not valid JSON."); }
  let settings;
  try { settings = parseRuntimeBudgetSettings(raw); }
  catch (error) {
    if (error instanceof ZodError) {
      const fields = [...new Set(error.issues.map(issue => issue.path.join(".") || "root"))].join(", ");
      throw new Error(`AI_BUDGET_POLICY_JSON has invalid fields: ${fields}.`);
    }
    throw new Error("AI_BUDGET_POLICY_JSON needs a reviewed costBasis.");
  }
  const basis = settings.costBasis;
  return { policyId: settings.policy.id, estimateMicros: settings.estimateMicros,
    quotedMicros: quotedEnvelopeMicros(basis, settings.maxModelCalls),
    models: settings.modelIds, reviewedAt: basis.reviewedAt, sourceHost: new URL(basis.sourceUrl).host };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkBudgetPolicy();
    console.log(`Budget policy ${result.policyId}: quote ${result.quotedMicros} micro-USD <= reservation ${result.estimateMicros} micro-USD.`);
    console.log(`Models: ${result.models.join(", ")}; pricing reviewed ${result.reviewedAt} at ${result.sourceHost}.`);
    console.log("Review current provider prices, actual token bounds, paid tools and a real model turn before enabling production chat.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "AI_BUDGET_POLICY_JSON is invalid.");
    process.exitCode = 1;
  }
}
