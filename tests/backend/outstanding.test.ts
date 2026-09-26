import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { inspectOutstandingStarts } from "../../lib/budgets/outstanding";

let directory: string,path: string,access: ReturnType<typeof sqliteAccessStore>,budgets: ReturnType<typeof sqliteBudgetStore>;
const policy = { id: "inventory",dailyMicros: 100,maxActive: 10,maxPerMinute: 10 };
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(),"jumpstart-inventory-")); path = join(directory,"app.sqlite");
  access = sqliteAccessStore(path); budgets = sqliteBudgetStore(path);
});
afterEach(async () => { await access.close(); await budgets.close(); await rm(directory,{ recursive: true,force: true }); });

it("classifies budget-only, pending, active and revoked reservations without changing them",async () => {
  const owner = { tenant: randomUUID(),subject: "alice" }, now = Date.now();
  const ids = [randomUUID(),randomUUID(),randomUUID(),randomUUID()];
  for (const [index,operationId] of ids.entries()) {
    await budgets.reserve({ ...owner,operationId,requestHash: "a".repeat(64),estimateMicros: 20,policy,now: now+index });
    if (index) await access.reserve({ ...owner,id: randomUUID(),operationId,requestHash: "a".repeat(64) });
  }
  await access.bind(owner,ids[2],"active-runtime");
  await budgets.claimAttempt({ ...owner,operationId: ids[2],attemptId: "b".repeat(64),maxAttempts: 2 });
  await access.cancelStarting(owner,ids[3]);
  const rows = [];
  let cursor: string | undefined;
  do {
    const page = await inspectOutstandingStarts(access,budgets,{ limit: 2,...(cursor ? { cursor } : {}) });
    expect(page.inspectedAt).toBeGreaterThanOrEqual(now);
    rows.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(rows.map(row => row.operationId)).toEqual(ids);
  expect(rows.map(row => row.conversationStatus)).toEqual(["missing","starting","active","revoked"]);
  expect(rows.map(row => row.attempts)).toEqual([0,0,1,0]);
  expect(rows[2].sessionId).toBe("active-runtime");
  expect(JSON.stringify(rows)).not.toContain("requestHash");
  expect((await budgets.snapshot({ ...owner,now })).active).toBe(4);
});

it("runs a bounded read-only operator CLI and rejects an invalid limit",async () => {
  const owner = { tenant: randomUUID(),subject: "alice" },operationId = randomUUID();
  await budgets.reserve({ ...owner,operationId,requestHash: "a".repeat(64),estimateMicros: 20,policy,now: Date.now() });
  const env = { ...process.env,DATA_PROVIDER: "sqlite",SQLITE_PATH: path };
  const run = (...args: string[]) => spawnSync("npm",["run","starts:inspect","--",...args],{ cwd: process.cwd(),env,encoding: "utf8",timeout: 20000 });
  const result = run("list","--limit","1");
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.slice(result.stdout.indexOf("{")))).toMatchObject({ items: [{ operationId,conversationStatus: "missing",attempts: 0 }],nextCursor: null });
  const invalid = run("list","--limit","101");
  expect(invalid.status).toBe(2);
});
