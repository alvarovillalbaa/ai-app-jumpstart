import { expect, it } from "vitest";
import { parseRuntimeBudgetSettings } from "../../lib/budgets/runtime";
import { quotedEnvelopeMicros } from "../../lib/budgets/cost-basis";
import { checkBudgetPolicy } from "../../scripts/check-budget-policy";

const basis = { sourceUrl: "https://example.test/fixture-prices", reviewedAt: "2026-09-24", maxOtherMicros: 3,
  models: [
    { id: "model-a", maxInputTokens: 3, maxOutputTokens: 2, inputMicrosPerMillion: 400_000, outputMicrosPerMillion: 1_200_000 },
    { id: "model-b", maxInputTokens: 2, maxOutputTokens: 3, inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 },
  ] };
const settings = { policy: { id: "review-v1", dailyMicros: 100, maxActive: 2, maxPerMinute: 10 },
  estimateMicros: 18, maxModelCalls: 3, modelIds: ["model-a", "model-b"], costBasis: basis };

it("quotes the priciest permitted call, rounds components up and includes other costs", () => {
  // model-a: ceil(1.2) + ceil(2.4) = 5; model-b: 2 + 3 = 5.
  expect(quotedEnvelopeMicros(basis, 3)).toBe(BigInt(18));
  expect(parseRuntimeBudgetSettings(settings).estimateMicros).toBe(18);
  expect(() => parseRuntimeBudgetSettings({ ...settings, estimateMicros: 17 })).toThrow("Reservation is below");
  expect(() => parseRuntimeBudgetSettings({ ...settings, policy: { ...settings.policy, dailyMicros: 17 } })).toThrow("exceeds the daily allowance");
});

it("requires an attributed review whenever chat is enabled and exact coverage of allowed models", () => {
  expect(() => parseRuntimeBudgetSettings({ ...settings, costBasis: undefined })).toThrow();
  for (const models of [[basis.models[0]], [basis.models[0], basis.models[0]], [...basis.models, { ...basis.models[0], id: "extra" }]]) {
    expect(() => parseRuntimeBudgetSettings({ ...settings, costBasis: { ...basis, models } })).toThrow("exactly once");
  }
  for (const sourceUrl of ["http://example.test/prices", "https://user:secret@example.test/prices", "https://example.test/prices?key=secret"]) {
    expect(() => parseRuntimeBudgetSettings({ ...settings, costBasis: { ...basis, sourceUrl } })).toThrow();
  }
});

it("rejects arithmetic overflow rather than trusting an unsafe floating-point quote", () => {
  const oversized = { ...settings, costBasis: { ...basis, models: basis.models.map(model => ({ ...model,
    maxInputTokens: 10_000_000, maxOutputTokens: 10_000_000,
    inputMicrosPerMillion: 1_000_000_000_000, outputMicrosPerMillion: 1_000_000_000_000 })) } };
  expect(() => parseRuntimeBudgetSettings(oversized)).toThrow("Reservation is below");
});

it("gives an operator a secret-free policy check using the production parser", () => {
  expect(checkBudgetPolicy({ NODE_ENV: "production", AI_BUDGET_POLICY_JSON: JSON.stringify(settings) })).toMatchObject({
    policyId: "review-v1", quotedMicros: BigInt(18), estimateMicros: 18,
    models: ["model-a", "model-b"], sourceHost: "example.test",
  });
  const secret = "private-fixture-value";
  const invalid = { NODE_ENV: "production" as const, AI_BUDGET_POLICY_JSON: JSON.stringify({ ...settings, costBasis: { ...basis, sourceUrl: `https://example.test/?key=${secret}` } }) };
  expect(() => checkBudgetPolicy(invalid)).toThrow("costBasis.sourceUrl");
  try { checkBudgetPolicy(invalid); }
  catch (error) { expect(String(error)).toContain("costBasis.sourceUrl"); expect(String(error)).not.toContain(secret); }
});
