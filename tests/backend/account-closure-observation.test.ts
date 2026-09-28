import { DatabaseSync } from "node:sqlite";
import { mkdirSync,mkdtempSync,rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { localUploadObjects } from "../../lib/uploads/local";
import { inspectAccountClosure } from "../../scripts/inspect-account-closure";
import { installSqliteAccountFences } from "../../lib/account-closure/sqlite-fences";

it("joins the real SQLite row and local object observations without exposing identity or partial output",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-closure-observation-")),path = join(dir,"app.sqlite"),root = join(dir,"uploads");
  const alice = { tenant: "private-tenant",subject: "private-alice" },bob = { ...alice,subject: "private-bob" };
  try {
    mkdirSync(root,{ mode: 0o700 });
    const stores = [new SqliteRepository(path),sqliteAccessStore(path),sqliteBudgetStore(path),
      sqliteUploadCatalog(path),sqlitePreferenceStore(path),sqliteRequestLimitStore(path)];
    for (const store of stores) await store.close();
    const db = new DatabaseSync(path);
    try {
      db.prepare("INSERT INTO app_records VALUES(?,?,?,'A','private',1,'now','now')").run(crypto.randomUUID(),alice.tenant,alice.subject);
      db.prepare("INSERT INTO app_records VALUES(?,?,?,'B','private',1,'now','now')").run(crypto.randomUUID(),bob.tenant,bob.subject);
      const id = crypto.randomUUID(),objects = localUploadObjects(root);
      await objects.put(alice,id,new TextEncoder().encode("orphan bytes with no catalog row"));
      const env = { ACCOUNT_AUDIT_SQLITE_PATH: path,UPLOAD_LOCAL_ROOT: root };
      const observed = await inspectAccountClosure("sqlite","local",alice,env);
      expect(observed).toMatchObject({ status: "retained_or_unattributable",ownerRowTotal: 1,objectCount: 1,
        remaining: { applicationRows: true,privateObjects: true,globalUnattributableRows: false } });
      expect(JSON.stringify(observed)).not.toContain(alice.tenant);
      expect(JSON.stringify(observed)).not.toContain(alice.subject);
      expect((await inspectAccountClosure("sqlite","local",bob,env)).objectCount).toBe(0);
      const success = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/inspect-account-closure.ts",
        "--metadata","sqlite","--read-only"],{ cwd: process.cwd(),encoding: "utf8",env: { ...process.env,
          ACCOUNT_AUDIT_TENANT: alice.tenant,ACCOUNT_AUDIT_SUBJECT: alice.subject,ACCOUNT_AUDIT_SQLITE_PATH: path,
          UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: root } });
      expect(success.status).toBe(0);
      expect(JSON.parse(success.stdout)).toMatchObject({ ownerRowTotal: 1,objectCount: 1,status: "retained_or_unattributable" });
      expect(success.stdout).not.toContain(alice.tenant);
      expect(success.stdout).not.toContain(alice.subject);

      db.prepare("DELETE FROM app_records WHERE tenant=? AND subject=?").run(alice.tenant,alice.subject);
      await objects.delete(alice,id);
      expect(await inspectAccountClosure("sqlite","local",alice,env)).toMatchObject({ status: "unfenced_zero",ownerRowTotal: 0,objectCount: 0 });
      expect(() => db.exec("INSERT INTO app_budget_attempts VALUES('missing-operation','orphan-attempt')"))
        .toThrow("no attributable owner");
      db.exec("DROP TRIGGER app_budget_attempts_account_fence_insert");
      db.exec("INSERT INTO app_budget_attempts VALUES('missing-operation','orphan-attempt')");
      installSqliteAccountFences(db,["app_budget_attempts"]);
      expect(await inspectAccountClosure("sqlite","local",alice,env)).toMatchObject({ status: "retained_or_unattributable",
        remaining: { applicationRows: false,privateObjects: false,globalUnattributableRows: true },orphanRowTotal: 1 });

      const failed = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/inspect-account-closure.ts",
        "--metadata","sqlite","--read-only"],{ cwd: process.cwd(),encoding: "utf8",env: { ...process.env,
          ACCOUNT_AUDIT_TENANT: alice.tenant,ACCOUNT_AUDIT_SUBJECT: alice.subject,ACCOUNT_AUDIT_SQLITE_PATH: path,
          UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: join(dir,"missing") } });
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).not.toContain(alice.tenant);
      expect(failed.stderr).not.toContain(alice.subject);
      expect(failed.stderr).not.toContain(dir);
    } finally { db.close(); }
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});
