import { expect, it } from "vitest";
import { chatSettings } from "../../lib/agent-access/settings";

const env = { NODE_ENV: "test" as const, AI_CHAT_ENABLED: "true", AUTH_PROVIDER: "supabase",
  SUPABASE_AUTH_URL: "https://auth.example", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture_only",
  AI_CREATION_SIGNING_JSON: JSON.stringify({ audience: "fixture", activeKey: "one", keys: { one: "a".repeat(64) } }),
  AI_RUNTIME_ORIGIN: "http://127.0.0.1:4274",
  AI_BUDGET_POLICY_JSON: JSON.stringify({ policy: { id: "fixture", dailyMicros: 60, maxActive: 2, maxPerMinute: 20 }, estimateMicros: 20, maxModelCalls: 1, modelIds: ["fixture"],
    costBasis: { sourceUrl: "https://example.test/fixture-prices", reviewedAt: "2026-09-24", maxOtherMicros: 0,
      models: [{ id: "fixture", maxInputTokens: 1, maxOutputTokens: 1, inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 }] } }),
};
it("requires explicit enablement and complete account/signing/budget settings", () => {
  expect(chatSettings({ NODE_ENV: "test" })).toBeNull();
  expect(chatSettings({ ...env, AI_CHAT_ENABLED: "false" })).toBeNull();
  expect(chatSettings(env)?.origin).toBe(env.AI_RUNTIME_ORIGIN);
  for (const change of [{ AI_CHAT_ENABLED: "yes" }, { AUTH_PROVIDER: "api-key" }, { AI_CREATION_SIGNING_JSON: "{}" }, { AI_BUDGET_POLICY_JSON: "{}" },
    { AI_BUDGET_POLICY_JSON: JSON.stringify({ policy: { id: "fixture", dailyMicros: 60, maxActive: 2, maxPerMinute: 20 }, estimateMicros: 20, maxModelCalls: 1, modelIds: ["fixture"] }) }]) {
    expect(() => chatSettings({ ...env, ...change })).toThrow(expect.objectContaining({ status: 503, code: "chat_unconfigured" }));
  }
});
it("rejects unsafe/misrouted origins and does not disclose invalid settings", () => {
  for (const origin of ["http://remote.example", "https://user:secret@remote.example", "https://remote.example/other", "https://remote.example/?secret=yes"]) {
    expect(() => chatSettings({ ...env, AI_RUNTIME_ORIGIN: origin })).toThrow("Chat configuration is unavailable.");
  }
});
