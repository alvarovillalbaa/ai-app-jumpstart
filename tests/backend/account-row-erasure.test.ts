import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync,mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { accountOwnerDeleteQueries } from "../../scripts/account-data-inventory.mjs";
import { eraseAccountRows } from "../../scripts/erase-account-rows";
import { exportAccountBundle } from "../../scripts/export-account-bundle";
import { setSqliteAccountFence } from "../../scripts/fence-account-writes";

const alice = { tenant: "erasure-tenant",subject: "alice" },bob = { ...alice,subject: "bob" };

it("derives child-first owner-scoped deletion for both SQL backends",() => {
  for (const provider of ["sqlite","sql"] as const) {
    const queries = accountOwnerDeleteQueries(provider);
    expect(queries.map(query => query.entity)).toContain("artifactVersions");
    expect(queries.findIndex(query => query.entity === "artifactVersions"))
      .toBeLessThan(queries.findIndex(query => query.entity === "artifacts"));
    expect(queries.findIndex(query => query.entity === "budgetAttempts"))
      .toBeLessThan(queries.findIndex(query => query.entity === "budgetReservations"));
    expect(queries.find(query => query.entity === "budgetAttempts")?.sql).toContain("subject=");
    expect(queries.every(query => query.sql.startsWith("DELETE FROM "))).toBe(true);
  }
});

it("erases only the bundled fenced owner's SQLite rows atomically and retains the fence",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-row-erasure-"));
  const path = join(dir,"app.sqlite"),root = join(dir,"objects"),bundle = join(dir,"bundle");
  try {
    mkdirSync(root,{ mode: 0o700 });
    const stores = [new SqliteRepository(path),sqliteAccessStore(path),sqliteBudgetStore(path),
      sqliteUploadCatalog(path),sqlitePreferenceStore(path),sqliteRequestLimitStore(path)];
    for (const store of stores) await store.close();
    const db = new DatabaseSync(path);
    try {
      db.prepare("INSERT INTO app_records VALUES('alice-record',?,?,'A','alice secret',1,'now','now')")
        .run(alice.tenant,alice.subject);
      db.prepare("INSERT INTO app_records VALUES('bob-record',?,?,'B','bob secret',1,'now','now')")
        .run(bob.tenant,bob.subject);
      db.prepare("INSERT INTO app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status) VALUES('alice-operation',?,?,'hash','policy',1,1,1,'reserved')")
        .run(alice.tenant,alice.subject);
      db.exec("INSERT INTO app_budget_attempts VALUES('alice-operation','alice-attempt')");
    } finally { db.close(); }
    setSqliteAccountFence(path,alice);
    const env = { ACCOUNT_AUDIT_SQLITE_PATH: path,UPLOAD_LOCAL_ROOT: root };
    await exportAccountBundle("sqlite","local",alice,bundle,env);
    expect(await eraseAccountRows("sqlite",alice,bundle,env)).toMatchObject({ rows: 3,
      status: "application-row-erasure-planned" });
    await expect(eraseAccountRows("sqlite",bob,bundle,env,true)).rejects.toThrow("does not match");
    const blocked = new DatabaseSync(path);
    try {
      expect(blocked.prepare("SELECT COUNT(*) AS count FROM app_budget_attempts").get()).toEqual({ count: 1 });
      blocked.exec("CREATE TRIGGER block_reservation_delete BEFORE DELETE ON app_budget_reservations BEGIN SELECT RAISE(ABORT,'blocked deletion'); END");
    } finally { blocked.close(); }
    await expect(eraseAccountRows("sqlite",alice,bundle,env,true)).rejects.toThrow("blocked deletion");
    const afterRollback = new DatabaseSync(path);
    try {
      expect(afterRollback.prepare("SELECT COUNT(*) AS count FROM app_budget_attempts").get()).toEqual({ count: 1 });
      expect(afterRollback.prepare("SELECT COUNT(*) AS count FROM app_records WHERE subject='alice'").get()).toEqual({ count: 1 });
      afterRollback.exec("DROP TRIGGER block_reservation_delete");
    } finally { afterRollback.close(); }
    expect(await eraseAccountRows("sqlite",alice,bundle,env,true)).toMatchObject({ rows: 3,
      status: "application-rows-erased" });
    const final = new DatabaseSync(path);
    try {
      expect(final.prepare("SELECT COUNT(*) AS count FROM app_records WHERE subject='alice'").get()).toEqual({ count: 0 });
      expect(final.prepare("SELECT COUNT(*) AS count FROM app_budget_attempts").get()).toEqual({ count: 0 });
      expect(final.prepare("SELECT content FROM app_records WHERE subject='bob'").get()).toEqual({ content: "bob secret" });
      expect(final.prepare("SELECT COUNT(*) AS count FROM app_account_fences WHERE tenant=? AND subject=?")
        .get(alice.tenant,alice.subject)).toEqual({ count: 1 });
      expect(() => final.prepare("INSERT INTO app_records VALUES('late',?,?,'A','late',1,'now','now')")
        .run(alice.tenant,alice.subject)).toThrow("fenced");
    } finally { final.close(); }
    await expect(eraseAccountRows("sqlite",alice,bundle,env,true)).rejects.toThrow("differ");
    const cli = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/erase-account-rows.ts",
      "--metadata","sqlite","--source",bundle,"--stopped"],{ cwd: process.cwd(),encoding: "utf8",
      env: { ...process.env,...env,ACCOUNT_AUDIT_TENANT: alice.tenant,ACCOUNT_AUDIT_SUBJECT: alice.subject } });
    expect(cli.status).toBe(2);
  } finally { rmSync(dir,{ recursive: true,force: true }); }
},30_000);
