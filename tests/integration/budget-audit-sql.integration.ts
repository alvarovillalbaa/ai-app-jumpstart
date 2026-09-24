import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, it } from "vitest";
import { createBudgetStore } from "../../lib/budgets/store";

if (process.env.DATA_PROVIDER === "postgres" || process.env.DATA_PROVIDER === "supabase") {
  it("rejects direct changes to a committed budget correction audit row",async () => {
    const owner = { tenant: randomUUID(),subject: "alice" },operationId = randomUUID(),correctionId = randomUUID();
    const budgets = await createBudgetStore();
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await budgets.reserve({ ...owner,operationId,requestHash: "a".repeat(64),estimateMicros: 60,
        policy: { id: "audit-test",dailyMicros: 100,maxActive: 1,maxPerMinute: 1 },now: Date.now() });
      await budgets.settle({ ...owner,operationId,actualMicros: null });
      expect(await budgets.correctSettlement({ ...owner,operationId,correctionId,expectedActualMicros: null,correctedActualMicros: 25,
        actor: "operator-1",reason: "Provider invoice confirms usage",evidenceRef: "invoice:test-1" })).toBe("applied");
      await client.connect();
      await expect(client.query("UPDATE public.app_budget_corrections SET reason='tampered audit entry' WHERE correction_id=$1",[correctionId])).rejects.toThrow(/immutable/);
      await expect(client.query("DELETE FROM public.app_budget_corrections WHERE correction_id=$1",[correctionId])).rejects.toThrow(/immutable/);
      expect(await budgets.listCorrections({ ...owner,operationId })).toEqual([expect.objectContaining({ correctionId,reason: "Provider invoice confirms usage" })]);
    } finally { await Promise.allSettled([client.end(),budgets.close()]); }
  });
}
