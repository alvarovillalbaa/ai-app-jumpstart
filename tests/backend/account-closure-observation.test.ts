import { DatabaseSync } from "node:sqlite";
import { mkdirSync,mkdtempSync,rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it,vi } from "vitest";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { localUploadObjects } from "../../lib/uploads/local";
import { inspectAccountClosure } from "../../scripts/inspect-account-closure";
import { inspectSupabaseAuthSessionRows } from "../../scripts/inspect-account-auth-sessions";
import { inspectAccountWorkflow } from "../../scripts/inspect-account-workflow.mjs";
import { setSqliteAccountFence } from "../../scripts/fence-account-writes";
import { installSqliteAccountFences } from "../../lib/account-closure/sqlite-fences";

vi.mock("../../scripts/inspect-account-auth-sessions",() => ({ inspectSupabaseAuthSessionRows: vi.fn() }));
vi.mock("../../scripts/inspect-account-workflow.mjs",() => ({ inspectAccountWorkflow: vi.fn() }));

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
      const env = { AUTH_PROVIDER: "api-key",ACCOUNT_AUDIT_SQLITE_PATH: path,UPLOAD_LOCAL_ROOT: root };
      const observed = await inspectAccountClosure("sqlite","local",alice,env);
      expect(observed).toMatchObject({ status: "retained_or_unattributable",ownerRowTotal: 1,objectCount: 1,
        authProvider: "api-key",authIdentityApplicable: false,authIdentityPresent: false,applicationWriteFenced: false,
        remaining: { applicationRows: true,privateObjects: true,globalUnattributableRows: false,applicationWritesPossible: true } });
      expect(observed.workflow).toBeNull();
      expect(observed.remaining.workflowRows).toBeNull();
      expect(observed.authSessionRows).toBeNull();
      expect(observed.remaining.authSessionRows).toBeNull();
      expect(JSON.stringify(observed)).not.toContain(alice.tenant);
      expect(JSON.stringify(observed)).not.toContain(alice.subject);
      expect((await inspectAccountClosure("sqlite","local",bob,env)).objectCount).toBe(0);
      const success = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/inspect-account-closure.ts",
        "--metadata","sqlite","--read-only"],{ cwd: process.cwd(),encoding: "utf8",env: { ...process.env,
        ACCOUNT_AUDIT_TENANT: alice.tenant,ACCOUNT_AUDIT_SUBJECT: alice.subject,ACCOUNT_AUDIT_SQLITE_PATH: path,
          AUTH_PROVIDER: "api-key",UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: root } });
      expect(success.status).toBe(0);
      expect(JSON.parse(success.stdout)).toMatchObject({ ownerRowTotal: 1,objectCount: 1,status: "retained_or_unattributable" });
      expect(JSON.parse(success.stdout).workflow).toBeNull();
      expect(JSON.parse(success.stdout).remaining.workflowRows).toBeNull();
      expect(success.stdout).not.toContain(alice.tenant);
      expect(success.stdout).not.toContain(alice.subject);

      db.prepare("DELETE FROM app_records WHERE tenant=? AND subject=?").run(alice.tenant,alice.subject);
      await objects.delete(alice,id);
      expect(await inspectAccountClosure("sqlite","local",alice,env)).toMatchObject({ status: "unfenced_zero",ownerRowTotal: 0,objectCount: 0 });
      const workflowObservation = { format: "ai-app-jumpstart-account-workflow-observation-v1",metadataProvider: "sqlite",
        workflowProvider: "postgres",boundSessionCount: 0,
        linkedRuns: { runs: 0,terminalRuns: 0,nonterminalRuns: 0,steps: 0,events: 0,hooks: 0,streamChunks: 0,
          waits: 0,eventSlots: 0,invocations: 0 },otherSessionRoots: 2,scope: "fixture" };
      vi.mocked(inspectAccountWorkflow).mockResolvedValueOnce(workflowObservation);
      expect(await inspectAccountClosure("sqlite","local",alice,env,fetch,{ workflowPostgres: true }))
        .toMatchObject({ format: "ai-app-jumpstart-account-closure-observation-v3",status: "retained_or_unattributable",
          remaining: { workflowRows: false,workflowUnattributedRoots: 2 } });
      vi.mocked(inspectAccountWorkflow).mockResolvedValueOnce({ ...workflowObservation,otherSessionRoots: 0 });
      expect(await inspectAccountClosure("sqlite","local",alice,env,fetch,{ workflowPostgres: true }))
        .toMatchObject({ status: "unfenced_zero",remaining: { workflowRows: false,workflowUnattributedRoots: 0 } });
      expect(await inspectAccountClosure("sqlite","local",alice,env)).toMatchObject({
        remaining: { workflowRows: null,workflowUnattributedRoots: null } });
      expect(setSqliteAccountFence(path,alice)).toMatchObject({ status: "fenced",provider: "sqlite" });
      expect(await inspectAccountClosure("sqlite","local",alice,env)).toMatchObject({ status: "application_fenced_zero",
        applicationWriteFenced: true,remaining: { applicationRows: false,privateObjects: false,applicationWritesPossible: false } });
      expect(() => db.prepare("INSERT INTO app_records VALUES(?,?,?,'A','private',1,'now','now')")
        .run(crypto.randomUUID(),alice.tenant,alice.subject)).toThrow("fenced");
      expect(() => db.exec("INSERT INTO app_budget_attempts VALUES('missing-operation','orphan-attempt')"))
        .toThrow("no attributable owner");
      db.exec("DROP TRIGGER app_budget_attempts_account_fence_insert");
      db.exec("INSERT INTO app_budget_attempts VALUES('missing-operation','orphan-attempt')");
      installSqliteAccountFences(db,["app_budget_attempts"]);
      expect(await inspectAccountClosure("sqlite","local",alice,env)).toMatchObject({ status: "retained_or_unattributable",
        applicationWriteFenced: true,
        remaining: { applicationRows: false,privateObjects: false,globalUnattributableRows: true,applicationWritesPossible: false },orphanRowTotal: 1 });

      const failed = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/inspect-account-closure.ts",
        "--metadata","sqlite","--read-only"],{ cwd: process.cwd(),encoding: "utf8",env: { ...process.env,
        ACCOUNT_AUDIT_TENANT: alice.tenant,ACCOUNT_AUDIT_SUBJECT: alice.subject,ACCOUNT_AUDIT_SQLITE_PATH: path,
          AUTH_PROVIDER: "api-key",UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: join(dir,"missing") } });
      expect(failed.status).toBe(1);
      expect(failed.stdout).toBe("");
      expect(failed.stderr).not.toContain(alice.tenant);
      expect(failed.stderr).not.toContain(alice.subject);
      expect(failed.stderr).not.toContain(dir);

      const supabaseOwner = { tenant: "supabase:https://identity.example",subject: "715ed5db-f090-4b8c-a067-640ecee36aa0" };
      const authEnv = { ...env,AUTH_PROVIDER: "supabase",SUPABASE_AUTH_URL: "https://identity.example",
        SUPABASE_AUTH_ADMIN_KEY: "sb_secret_disposable_operator_fixture" };
      const authDatabaseEnv = { ...authEnv,SUPABASE_AUTH_DATABASE_URL: "postgresql://operator:private@db.example.test/auth" };
      let authPresent = true;
      const request: typeof fetch = async input => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        expect(url.origin).toBe("https://identity.example");
        expect(url.pathname).toBe(`/auth/v1/admin/users/${supabaseOwner.subject}`);
        return authPresent ? Response.json({ id: supabaseOwner.subject,email: "private@example.com",role: "authenticated",is_anonymous: false })
          : Response.json({ code: "user_not_found",msg: "User not found" },{ status: 404 });
      };
      await expect(inspectAccountClosure("sqlite","local",supabaseOwner,{ ...authEnv,AUTH_PROVIDER: "api-key" },request))
        .rejects.toThrow("requires AUTH_PROVIDER=supabase");
      const authObserved = await inspectAccountClosure("sqlite","local",supabaseOwner,authEnv,request);
      expect(authObserved).toMatchObject({ status: "retained_or_unattributable",authProvider: "supabase",
        authIdentityApplicable: true,authIdentityPresent: true,authSessionRows: null,
        remaining: { authIdentity: true,authSessionRows: null } });
      await expect(inspectAccountClosure("sqlite","local",alice,env,fetch,{ authSessionsPostgres: true }))
        .rejects.toThrow("requires AUTH_PROVIDER=supabase");
      await expect(inspectAccountClosure("sqlite","local",supabaseOwner,authEnv,request,{ authSessionsPostgres: true }))
        .rejects.toThrow("A Supabase Auth database URL is required");
      vi.mocked(inspectSupabaseAuthSessionRows).mockResolvedValueOnce(2);
      const withSessions = await inspectAccountClosure("sqlite","local",supabaseOwner,authDatabaseEnv,request,{ authSessionsPostgres: true });
      expect(inspectSupabaseAuthSessionRows).toHaveBeenCalledWith(authDatabaseEnv.SUPABASE_AUTH_DATABASE_URL,supabaseOwner.subject,true);
      expect(withSessions).toMatchObject({ authSessionRows: 2,remaining: { authSessionRows: 2 } });
      expect(JSON.stringify(withSessions)).not.toContain(authDatabaseEnv.SUPABASE_AUTH_DATABASE_URL);
      expect(JSON.stringify(authObserved)).not.toContain(supabaseOwner.subject);
      expect(JSON.stringify(authObserved)).not.toContain("private@example.com");
      expect(JSON.stringify(authObserved)).not.toContain(authEnv.SUPABASE_AUTH_ADMIN_KEY);
      authPresent = false;
      expect(await inspectAccountClosure("sqlite","local",supabaseOwner,authEnv,request)).toMatchObject({
        status: "retained_or_unattributable",authIdentityApplicable: true,authIdentityPresent: false,
        remaining: { authIdentity: false,globalUnattributableRows: true } });
      vi.mocked(inspectSupabaseAuthSessionRows).mockResolvedValueOnce(0);
      expect(await inspectAccountClosure("sqlite","local",supabaseOwner,authDatabaseEnv,request,{ authSessionsPostgres: true }))
        .toMatchObject({ authIdentityPresent: false,authSessionRows: 0,remaining: { authIdentity: false,authSessionRows: 0 } });
    } finally { db.close(); }
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});
