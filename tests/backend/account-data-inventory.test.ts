import { expect,it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { accountDataInventory,accountOrphanCountQueries,accountOwnerCountQueries,readAccountSchemaSources,verifyAccountDataInventory } from "../../scripts/account-data-inventory.mjs";
import { inspectSqliteAccountData } from "../../scripts/inspect-account-data.mjs";
import { installSqliteAccountFences } from "../../lib/account-closure/sqlite-fences";

const sources = readAccountSchemaSources();

it("classifies every current application table in SQL, SQLite and Convex",() => {
  expect(verifyAccountDataInventory(sources)).toEqual({ postgres: 18,sqlite: 17,convex: 18,ownerLinked: 17 });
});

it("fails when any provider adds a table without an account-data classification",() => {
  expect(() => verifyAccountDataInventory({ ...sources,sql: `${sources.sql}\nCREATE TABLE public.app_private_notes(id uuid);` }))
    .toThrow("unclassified [app_private_notes]");
  expect(() => verifyAccountDataInventory({ ...sources,sql: `${sources.sql}\nCREATE TABLE "public"."private_notes"(id uuid);` }))
    .toThrow("unclassified [private_notes]");
  expect(() => verifyAccountDataInventory({ ...sources,sqlite: `${sources.sqlite}\nCREATE TABLE app_private_notes(id TEXT);` }))
    .toThrow("unclassified [app_private_notes]");
  expect(() => verifyAccountDataInventory({ ...sources,convex: `${sources.convex}\nprivateNotes: defineTable({ id: v.string() }),` }))
    .toThrow("unclassified [privateNotes]");
});

it("fails if ownership or transient-table evidence disappears",() => {
  const withoutConversationSubject = sources.sqlite.replace("id TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL,",
    "id TEXT PRIMARY KEY, tenant TEXT NOT NULL, account_subject TEXT NOT NULL,");
  expect(withoutConversationSubject).not.toBe(sources.sqlite);
  expect(() => verifyAccountDataInventory({ ...sources,sqlite: withoutConversationSubject }))
    .toThrow("SQLite owner columns missing from app_conversations");
  const records = accountDataInventory.map(entry => entry.entity === "records" ? { ...entry,owner: "missingParent" } : entry);
  expect(() => verifyAccountDataInventory(sources,records)).toThrow("Unresolved account owner path for records");
  expect(() => verifyAccountDataInventory({ ...sources,sqlite: sources.sqlite.replace("ALTER TABLE app_uploads_scan_upgrade RENAME TO app_uploads", "ALTER TABLE app_uploads_scan_upgrade RENAME TO something_else") }))
    .toThrow("unclassified [app_uploads_scan_upgrade]");
});

it("discovers a new SQLite table in a newly added module",() => {
  const base = mkdtempSync(join(tmpdir(),"jumpstart-account-schema-"));
  try {
    for (const path of ["migrations","convex","lib/nested"]) mkdirSync(join(base,path),{ recursive: true });
    writeFileSync(join(base,"migrations/all.sql"),sources.sql);
    writeFileSync(join(base,"convex/schema.ts"),sources.convex);
    writeFileSync(join(base,"lib/current.ts"),sources.sqlite);
    writeFileSync(join(base,"lib/nested/new.ts"),"CREATE TABLE app_unclassified_private_data(id TEXT);");
    expect(() => verifyAccountDataInventory(readAccountSchemaSources(base))).toThrow("unclassified [app_unclassified_private_data]");
  } finally { rmSync(base,{ recursive: true,force: true }); }
});

it("finds two owners' real SQLite rows, including child data and tombstones",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-account-inventory-")),path = join(dir,"app.sqlite");
  const stores = [new SqliteRepository(path),sqliteAccessStore(path),sqliteBudgetStore(path),
    sqliteUploadCatalog(path),sqlitePreferenceStore(path),sqliteRequestLimitStore(path)];
  try {
    for (const store of stores) await store.close();
    const db = new DatabaseSync(path);
    try {
      db.exec(`INSERT INTO app_records VALUES('r1','acme','alice','A','secret',1,'now','now');
        INSERT INTO app_records VALUES('r2','acme','bob','B','private',1,'now','now');
        INSERT INTO app_conversations(id,tenant,subject,operation_id,request_hash,session_id,status)
          VALUES('c1','acme','alice','o1','hash','s1','active');
        INSERT INTO app_artifacts(id,operation_id,session_id,call_id,input_hash,title,content,created_at,revision,updated_at)
          VALUES('a1','o1','s1','call1','hash','Artifact','private',1,1,1);
        INSERT INTO app_uploads VALUES('u1','acme','alice','private.txt','text/plain',7,'hash',1,'deleted');
        INSERT INTO app_upload_scans VALUES('u1','hash','clean',NULL,1,1);
        INSERT INTO app_upload_reviews VALUES('u1',1,NULL,NULL,NULL);
        INSERT INTO app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status)
          VALUES('o1','acme','alice','hash','policy',100,1,1,'reserved');
        INSERT INTO app_budget_attempts VALUES('o1','attempt1');`);
      const queries = accountOwnerCountQueries("sqlite");
      expect(queries).toHaveLength(15);
      const count = (tenant: string,subject: string) => Object.fromEntries(queries.map(query =>
        [query.entity,(db.prepare(query.sql).get(tenant,subject) as { count: number }).count]));
      const alice = count("acme","alice"),bob = count("acme","bob");
      expect(alice).toMatchObject({ records: 1,conversations: 1,artifacts: 1,artifactVersions: 1,
        uploads: 1,uploadScans: 1,uploadReviews: 1,budgetReservations: 1,budgetAttempts: 1 });
      expect(bob.records).toBe(1);
      expect(Object.entries(bob).filter(([entity]) => entity !== "records").every(([,value]) => value === 0)).toBe(true);
      expect(accountOwnerCountQueries("sql")).toHaveLength(16);
      const orphanQueries = accountOrphanCountQueries("sqlite");
      expect(orphanQueries.every(query => (db.prepare(query.sql).get() as { count: number }).count === 0)).toBe(true);
      expect(() => db.exec("INSERT INTO app_budget_attempts VALUES('missing-operation','orphan-attempt')"))
        .toThrow("no attributable owner");
      // Simulate a legacy orphan left before write guards were installed.
      db.exec("DROP TRIGGER app_budget_attempts_account_fence_insert");
      db.exec("INSERT INTO app_budget_attempts VALUES('missing-operation','orphan-attempt')");
      installSqliteAccountFences(db,["app_budget_attempts"]);
      expect((db.prepare(orphanQueries.find(query => query.entity === "budgetAttempts")!.sql).get() as { count: number }).count).toBe(1);
      const report = inspectSqliteAccountData(path,"acme","alice");
      expect(report).toMatchObject({ provider: "sqlite",ownerRowTotal: 9,orphanRowTotal: 1,
        ownerRows: { records: 1,uploads: 1,uploadScans: 1,uploadReviews: 1 },
        orphanRows: { budgetAttempts: 1 } });
      const result = spawnSync(process.execPath,["scripts/inspect-account-data.mjs","--sqlite",path],{
        cwd: process.cwd(),encoding: "utf8",env: { ...process.env,ACCOUNT_AUDIT_TENANT: "acme",ACCOUNT_AUDIT_SUBJECT: "bob" },
      });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ provider: "sqlite",ownerRowTotal: 1,orphanRowTotal: 1 });
      expect(result.stdout).not.toContain("acme");
      expect(result.stdout).not.toContain("bob");
      const missing = spawnSync(process.execPath,["scripts/inspect-account-data.mjs","--sqlite",join(dir,"missing.sqlite")],{
        cwd: process.cwd(),encoding: "utf8",env: { ...process.env,ACCOUNT_AUDIT_TENANT: "acme",ACCOUNT_AUDIT_SUBJECT: "alice" },
      });
      expect(missing.status).toBe(1);
      expect(missing.stdout).toBe("");
      expect(missing.stderr).not.toContain(dir);
      expect(missing.stderr).not.toContain("alice");
    } finally { db.close(); }
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});
