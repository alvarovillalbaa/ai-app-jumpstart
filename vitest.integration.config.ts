import { defineConfig } from "vitest/config";
export default defineConfig({ test: {
  include: ["tests/integration/records.integration.ts", "tests/integration/session-access.integration.ts", "tests/integration/budgets.integration.ts", "tests/integration/cancel-start.integration.ts", ...(process.env.DATA_PROVIDER === "postgres" || process.env.DATA_PROVIDER === "supabase" ? ["tests/integration/budget-audit-sql.integration.ts"] : []), ...(process.env.DATA_PROVIDER === "supabase" && process.env.TEST_SUPABASE_ANON_TOKEN ? ["tests/integration/supabase-access.integration.ts"] : [])],
  testTimeout: 20_000, hookTimeout: 20_000,
} });
