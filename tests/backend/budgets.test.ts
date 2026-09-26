import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { budgetContract } from "../contracts/budgets";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
budgetContract("SQLite", async () => sqliteBudgetStore(":memory:"));
it("persists reservations across independent connections and restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-budget-")), path = join(directory,"app.sqlite");
  const first = sqliteBudgetStore(path), second = sqliteBudgetStore(path);
  const input = { tenant: "test", subject: "alice", operationId: randomUUID(), requestHash: "a".repeat(64), estimateMicros: 60, policy: { id: "one", dailyMicros: 100, maxActive: 10, maxPerMinute: 10 }, now: Date.now() };
  try {
    const results = await Promise.all([first.reserve(input),second.reserve({ ...input, operationId: randomUUID() })]);
    expect(results.filter(r => r.status === "reserved")).toHaveLength(1);
  } finally { await first.close(); await second.close(); }
  const reopened = sqliteBudgetStore(path);
  try { expect(await reopened.snapshot({ tenant: input.tenant, subject: input.subject, now: input.now })).toMatchObject({ active: 1, reservedMicros: 60 }); }
  finally { await reopened.close(); await rm(directory,{ recursive: true }); }
});
