import { DatabaseSync } from "node:sqlite";
import { mkdtempSync,rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { sqliteFencedTables } from "../../lib/account-closure/sqlite-fences";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { setSqliteAccountFence } from "../../scripts/fence-account-writes";
import { accountDataInventory } from "../../scripts/account-data-inventory.mjs";

it("guards every classified SQLite owner-linked table",() => {
  expect([...sqliteFencedTables].sort()).toEqual(accountDataInventory
    .filter(entry => entry.sqlite && entry.owner !== "global-expiring" && entry.owner !== "closure-control")
    .map(entry => entry.sqlite).sort());
});

it("permanently fences an owner's SQLite application rows across stores while preserving reads and other owners",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-row-fence-")),path = join(dir,"app.sqlite");
  const alice = { tenant: "private-tenant",subject: "private-alice" },bob = { ...alice,subject: "private-bob" };
  try {
    const stores = [new SqliteRepository(path),sqliteAccessStore(path),sqliteBudgetStore(path),
      sqliteUploadCatalog(path),sqlitePreferenceStore(path),sqliteRequestLimitStore(path)];
    for (const store of stores) await store.close();
    const db = new DatabaseSync(path);
    try {
      const installed = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map(row => row.name));
      for (const table of sqliteFencedTables) {
        expect(installed.has(`${table}_account_fence_insert`),`${table} insert guard`).toBe(true);
        expect(installed.has(`${table}_account_fence_update`),`${table} update guard`).toBe(true);
      }
      db.prepare("INSERT INTO app_records VALUES('a',?,?,'A','secret',1,'now','now')").run(alice.tenant,alice.subject);
      db.prepare("INSERT INTO app_records VALUES('b',?,?,'B','private',1,'now','now')").run(bob.tenant,bob.subject);
      db.prepare(`INSERT INTO app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status)
        VALUES('oa',?,?,'hash','policy',1,1,1,'reserved')`).run(alice.tenant,alice.subject);
      db.prepare(`INSERT INTO app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status)
        VALUES('ob',?,?,'hash','policy',1,1,1,'reserved')`).run(bob.tenant,bob.subject);
      expect(setSqliteAccountFence(path,alice)).toMatchObject({ status: "fenced",created: true });
      expect(setSqliteAccountFence(path,alice)).toMatchObject({ status: "fenced",created: false });
      expect(() => db.prepare("INSERT INTO app_records VALUES('a2',?,?,'A2','late',1,'now','now')")
        .run(alice.tenant,alice.subject)).toThrow("fenced");
      expect(() => db.exec("UPDATE app_records SET content='changed' WHERE id='a'")).toThrow("fenced");
      expect(() => db.exec("INSERT INTO app_budget_attempts VALUES('oa','late-attempt')")).toThrow("fenced");
      expect(() => db.exec("UPDATE app_budget_reservations SET status='settled' WHERE operation_id='oa'")).toThrow("fenced");
      expect(() => db.exec("UPDATE app_records SET subject='private-bob' WHERE id='a'")).toThrow("owner cannot change");
      expect(() => db.exec("INSERT INTO app_budget_attempts VALUES('missing','orphan')")).toThrow("no attributable owner");
      db.exec("INSERT INTO app_budget_attempts VALUES('ob','bob-attempt')");
      db.exec("UPDATE app_records SET content='bob changed' WHERE id='b'");
      expect(db.prepare("SELECT content FROM app_records WHERE id='a'").get()).toMatchObject({ content: "secret" });
      expect(db.prepare("SELECT content FROM app_records WHERE id='b'").get()).toMatchObject({ content: "bob changed" });
      expect(() => db.exec("DELETE FROM app_account_fences")).toThrow("permanent");
      expect(() => db.exec("UPDATE app_account_fences SET created_at='later'")).toThrow("permanent");
      db.exec("DELETE FROM app_records WHERE id='a'");
      expect(db.prepare("SELECT count(*) AS count FROM app_records WHERE id='a'").get()).toMatchObject({ count: 0 });

      const cli = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/fence-account-writes.ts",
        "--metadata","sqlite","--set-permanent"],{ cwd: process.cwd(),encoding: "utf8",env: { ...process.env,
          ACCOUNT_AUDIT_TENANT: alice.tenant,ACCOUNT_AUDIT_SUBJECT: alice.subject,ACCOUNT_AUDIT_SQLITE_PATH: path } });
      expect(cli.status).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({ status: "fenced",created: false });
      expect(cli.stdout).not.toContain(alice.tenant);
      expect(cli.stdout).not.toContain(alice.subject);
    } finally { db.close(); }
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});

it("refuses an incompletely guarded SQLite schema without publishing a success",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-row-fence-incomplete-")),path = join(dir,"app.sqlite");
  try {
    const records = new SqliteRepository(path);await records.close();
    expect(() => setSqliteAccountFence(path,{ tenant: "one",subject: "two" })).toThrow("incomplete");
    const db = new DatabaseSync(path);
    try { expect(db.prepare("SELECT count(*) AS count FROM app_account_fences").get()).toMatchObject({ count: 0 }); }
    finally { db.close(); }
    expect(() => setSqliteAccountFence(join(dir,"missing.sqlite"),{ tenant: "one",subject: "two" })).toThrow();
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});
