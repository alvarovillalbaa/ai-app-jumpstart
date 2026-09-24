import { afterEach, beforeEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";

let directory: string,path: string,budgets: ReturnType<typeof sqliteBudgetStore>;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(),"jumpstart-reconcile-")); path = join(directory,"app.sqlite");
  budgets = sqliteBudgetStore(path);
});
afterEach(async () => { await budgets.close(); await rm(directory,{ recursive: true,force: true }); });

it("previews an operator correction, applies it once, and exposes its audit trail",async () => {
  const owner = { tenant: randomUUID(),subject: "alice" },operationId = randomUUID(),correctionId = randomUUID();
  await budgets.reserve({ ...owner,operationId,requestHash: "a".repeat(64),estimateMicros: 60,
    policy: { id: "operator-test",dailyMicros: 100,maxActive: 1,maxPerMinute: 1 },now: Date.now() });
  await budgets.settle({ ...owner,operationId,actualMicros: null });
  const env = { ...process.env,DATA_PROVIDER: "sqlite",SQLITE_PATH: path };
  const run = (...args: string[]) => spawnSync("npm",["run","budgets:reconcile","--",...args],
    { cwd: process.cwd(),env,encoding: "utf8",timeout: 20000 });
  const flags = ["--tenant",owner.tenant,"--subject",owner.subject];
  const correct = ["correct",operationId,...flags,"--correction-id",correctionId,"--expected","unknown","--actual","25",
    "--actor","operator-1","--reason","Provider invoice confirms final usage","--evidence","invoice:test-1"];
  const preview = run(...correct);
  expect(preview.status).toBe(0);
  expect(JSON.parse(preview.stdout.slice(preview.stdout.indexOf("{")))).toMatchObject({ apply: false,
    reservation: { status: "settled",actualMicros: null },wouldConflict: false });
  expect((await budgets.inspectReservation({ ...owner,operationId }))?.actualMicros).toBeNull();
  const applied = run(...correct,"--apply");
  expect(applied.status).toBe(0);
  expect(JSON.parse(applied.stdout.slice(applied.stdout.indexOf("{")))).toMatchObject({ correctionId,result: "applied" });
  const retry = run(...correct,"--apply");
  expect(retry.status).toBe(0);
  expect(JSON.parse(retry.stdout.slice(retry.stdout.indexOf("{"))).result).toBe("already_applied");
  const shown = run("show",operationId,...flags);
  expect(shown.status).toBe(0);
  expect(JSON.parse(shown.stdout.slice(shown.stdout.indexOf("{")))).toMatchObject({
    reservation: { status: "settled",actualMicros: 25 },recentCorrections: [{ correctionId,previousActualMicros: null,correctedActualMicros: 25 }],
  });
  const direct = new DatabaseSync(path);
  try {
    expect(() => direct.prepare("UPDATE app_budget_corrections SET reason='tampered' WHERE correction_id=?").run(correctionId)).toThrow(/immutable/);
    expect(() => direct.prepare("DELETE FROM app_budget_corrections WHERE correction_id=?").run(correctionId)).toThrow(/immutable/);
  } finally { direct.close(); }
  expect(run("correct",operationId,...flags,"--correction-id",randomUUID(),"--expected","unknown","--actual","0",
    "--actor","operator-1","--reason","Stale invoice correction attempt","--evidence","invoice:test-2","--apply").status).toBe(1);
  expect(run(...correct.slice(0,correct.indexOf("--actual")+1),"",...correct.slice(correct.indexOf("--actual")+2),"--apply").status).toBe(2);
});
