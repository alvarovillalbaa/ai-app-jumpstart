import { expect, it } from "vitest";
import { checkManagedConfig } from "../../scripts/check-managed-config";

const baseline = {
  NODE_ENV: "production" as const,
  DATA_PROVIDER: "supabase", AUTH_PROVIDER: "supabase", AI_CHAT_ENABLED: "false",
  APP_ORIGIN: "https://app.example.org", SUPABASE_URL: "https://data.example.org",
  SUPABASE_SECRET_KEY: "sb_secret_fixture_backend_key", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture_public_key",
};
const chat = {
  ...baseline, AI_CHAT_ENABLED: "true", AI_RUNTIME_ORIGIN: "https://app.example.org",
  AI_CREATION_SIGNING_JSON: JSON.stringify({ audience: "fixture:staging", activeKey: "v1", keys: { v1: "a".repeat(64) } }),
  AI_BUDGET_POLICY_JSON: JSON.stringify({ policy: { id: "fixture", dailyMicros: 100, maxActive: 1, maxPerMinute: 2 },
    estimateMicros: 10, maxModelCalls: 1, modelIds: ["openai/gpt-5.6-luna-fast"] }),
};

it("accepts an explicit records-first managed setup and a fully shaped account-chat setup", () => {
  expect(checkManagedConfig(baseline)).toEqual({ target: "vercel-supabase", origin: baseline.APP_ORIGIN, accountChat: "disabled" });
  expect(() => checkManagedConfig(baseline, true)).toThrow("Enable and configure AI_CHAT_ENABLED=true");
  expect(checkManagedConfig(chat, true)).toMatchObject({ accountChat: "enabled" });
});

it("rejects serverless-local storage, plaintext origins, wrong credentials and workflow world", () => {
  expect(() => checkManagedConfig({ ...baseline, DATA_PROVIDER: "sqlite" })).toThrow("DATA_PROVIDER=supabase");
  expect(() => checkManagedConfig({ ...baseline, APP_ORIGIN: "http://localhost:3000" })).toThrow("APP_ORIGIN");
  expect(() => checkManagedConfig({ ...baseline, SUPABASE_URL: "http://127.0.0.1:54321" })).toThrow("SUPABASE_URL");
  expect(() => checkManagedConfig({ ...baseline, SUPABASE_SECRET_KEY: baseline.SUPABASE_PUBLISHABLE_KEY })).toThrow("SUPABASE_SECRET_KEY");
  expect(() => checkManagedConfig({ ...baseline, EVE_WORKFLOW_PROVIDER: "postgres" })).toThrow("default Workflow world");
  expect(() => checkManagedConfig({ ...baseline, APP_AGENT_READINESS: "local" })).toThrow("co-located Eve");
});

it("fails closed for incomplete or malformed enabled chat without echoing secret values", () => {
  expect(() => checkManagedConfig({ ...baseline, AI_CHAT_ENABLED: "true" })).toThrow("AI_RUNTIME_ORIGIN");
  expect(() => checkManagedConfig({ ...chat, AI_RUNTIME_ORIGIN: "http://localhost:4274" })).toThrow("AI_RUNTIME_ORIGIN");
  const malformed = { ...chat, AI_BUDGET_POLICY_JSON: '{"secret":"private-fixture-value"}' };
  expect(() => checkManagedConfig(malformed)).toThrow("Account chat settings are invalid");
  try { checkManagedConfig(malformed); } catch (error) { expect(String(error)).not.toContain("private-fixture-value"); }
});
