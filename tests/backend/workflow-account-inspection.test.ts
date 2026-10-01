import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdirSync,mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { afterEach,expect,it,vi } from "vitest";
import { convexTest } from "convex-test";
import schema from "../../convex/schema";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { inspectAccountWorkflow } from "../../scripts/inspect-account-workflow.mjs";
import { inspectAccountClosure } from "../../scripts/inspect-account-closure";
import { workflowPostgresFixture } from "../../scripts/helpers/workflow-postgres-fixture.mjs";

const convexModules = import.meta.glob("../../convex/**/*.ts");
afterEach(() => vi.unstubAllEnvs());

it("counts only native Workflow runs linked to an owner's bound session and hides account identifiers",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-workflow-inspection-"));
  const path = join(dir,"app.sqlite"),uploadRoot = join(dir,"uploads"),workflow = await workflowPostgresFixture();
  const owner = { tenant: "private-tenant",subject: "private-subject" };
  try {
    const stores = [new SqliteRepository(path),sqliteAccessStore(path),sqliteBudgetStore(path),
      sqliteUploadCatalog(path),sqlitePreferenceStore(path),sqliteRequestLimitStore(path)];
    for (const store of stores) await store.close();
    mkdirSync(uploadRoot,{ mode: 0o700 });
    const sqlite = new DatabaseSync(path);
    try {
      const statement = sqlite.prepare(`INSERT INTO app_conversations
        (id,tenant,subject,operation_id,request_hash,session_id,status) VALUES (?,?,?,?,?,?,?)`);
      statement.run(crypto.randomUUID(),owner.tenant,owner.subject,crypto.randomUUID(),"a".repeat(64),"owned-session","active");
      statement.run(crypto.randomUUID(),owner.tenant,owner.subject,crypto.randomUUID(),"c".repeat(64),"retired-session","revoked");
      statement.run(crypto.randomUUID(),owner.tenant,"other-owner",crypto.randomUUID(),"b".repeat(64),"other-session","active");
    } finally { sqlite.close(); }
    const migration = spawnSync(process.execPath,["scripts/migrate-workflow.mjs"],{
      cwd: process.cwd(),encoding: "utf8",env: { ...process.env,WORKFLOW_POSTGRES_URL: workflow.url,
        WORKFLOW_POSTGRES_JOB_PREFIX: "account_inspection_test",EVE_WORKFLOW_PROVIDER: "postgres" } });
    expect(migration.status,migration.stderr).toBe(0);
    const pg = new Client({ connectionString: workflow.url });await pg.connect();
    try {
      for (const [id,attributes,status] of [
        ["owned-session",{"$eve.type":"session"},"completed"],
        ["owned-turn",{"$eve.type":"turn","$eve.parent":"owned-session","$eve.root":"owned-session"},"running"],
        ["owned-child",{"$eve.type":"subagent","$eve.parent":"owned-turn"},"completed"],
        ["retained-child",{"$eve.type":"turn","$eve.parent":"retired-session","$eve.root":"retired-session"},"completed"],
        ["other-session",{"$eve.type":"session"},"completed"],
        ["unlinked-auxiliary",{"$eve.type":"tool"},"completed"],
      ] as const) await pg.query(`INSERT INTO workflow.workflow_runs (id,deployment_id,status,name,attributes)
        VALUES ($1,'fixture',$3,'fixture',$2::jsonb)`,[id,JSON.stringify(attributes),status]);
      await pg.query(`INSERT INTO workflow.workflow_events (id,type,run_id) VALUES
        ('event-1','test','owned-turn'),('event-aux','test','unlinked-auxiliary')`);
      await pg.query(`INSERT INTO workflow.workflow_invocations (run_id,request_id,payload,fingerprint)
        VALUES ('owned-turn','owned-invocation',$1,'fixture-fingerprint'),
          ('other-session','foreign-invocation',$2,'foreign-fingerprint'),
          ('unlinked-auxiliary','aux-invocation',$2,'aux-fingerprint')`,
        [Buffer.from("private-invocation-payload"),Buffer.from("foreign-invocation-payload")]);
      const env = { ACCOUNT_AUDIT_SQLITE_PATH: path,WORKFLOW_POSTGRES_URL: workflow.url };
      const observed = await inspectAccountWorkflow("sqlite",owner,env);
      expect(observed).toMatchObject({ boundSessionCount: 2,
        format: "ai-app-jumpstart-account-workflow-observation-v2",
        linkedRuns: { runs: 4,terminalRuns: 3,nonterminalRuns: 1,events: 1,invocations: 1 },
        unattributedWorkflowRows: { runs: 2,events: 1,invocations: 2 },unattributedWorkflowRowCount: 5,otherSessionRoots: 1 });
      expect(JSON.stringify(observed)).not.toContain(owner.tenant);
      expect(JSON.stringify(observed)).not.toContain(owner.subject);
      expect(await inspectAccountWorkflow("sqlite",{ ...owner,subject: "missing" },env)).toMatchObject({
        boundSessionCount: 0,linkedRuns: { runs: 0,terminalRuns: 0,nonterminalRuns: 0,invocations: 0 },
        unattributedWorkflowRows: { runs: 6,events: 2,invocations: 3 },unattributedWorkflowRowCount: 11,otherSessionRoots: 2 });
      await pg.query(`CREATE TABLE public.app_conversations
        (tenant text NOT NULL,subject text NOT NULL,session_id text)`);
      await pg.query(`INSERT INTO public.app_conversations (tenant,subject,session_id) VALUES ($1,$2,'owned-session')`,
        [owner.tenant,owner.subject]);
      expect(await inspectAccountWorkflow("postgres",owner,{ DATABASE_URL: workflow.url,
        WORKFLOW_POSTGRES_URL: workflow.url })).toMatchObject({ boundSessionCount: 1,
        linkedRuns: { runs: 3,terminalRuns: 2,nonterminalRuns: 1,events: 1,invocations: 1 },
        unattributedWorkflowRows: { runs: 3,events: 1,invocations: 2 },unattributedWorkflowRowCount: 6 });
      const command = spawnSync(process.execPath,["scripts/inspect-account-workflow.mjs","--metadata","sqlite","--read-only"],{
        cwd: process.cwd(),encoding: "utf8",env: { ...process.env,...env,ACCOUNT_AUDIT_TENANT: owner.tenant,
          ACCOUNT_AUDIT_SUBJECT: owner.subject } });
      expect(command.status,command.stderr).toBe(0);
      expect(JSON.parse(command.stdout).linkedRuns.runs).toBe(4);
      expect(command.stdout).not.toContain(owner.subject);

      const auditSecret = "test-convex-workflow-audit-secret-".repeat(2);
      vi.stubEnv("CONVEX_AUDIT_SECRET",auditSecret);
      const convex = convexTest(schema,convexModules);
      await convex.run(async ctx => {
        for (let index = 0;index < 105;index++) await ctx.db.insert("conversations",{
          ...owner,id: crypto.randomUUID(),operationId: crypto.randomUUID(),requestHash: "d".repeat(64),
          sessionId: null,status: "active",archived: false,createdAt: index,
        });
        for (const [index,sessionId] of ["owned-session","retired-session"].entries()) await ctx.db.insert("conversations",{
          ...owner,id: crypto.randomUUID(),operationId: crypto.randomUUID(),requestHash: "e".repeat(64),
          sessionId,status: "active",archived: false,createdAt: 105+index,
        });
        await ctx.db.insert("conversations",{ tenant: owner.tenant,subject: "other-owner",id: crypto.randomUUID(),
          operationId: crypto.randomUUID(),requestHash: "f".repeat(64),sessionId: "other-session",status: "active",
          archived: false,createdAt: 107 });
      });
      const convexRequest: typeof fetch = (url,init) => convex.fetch(
        new URL(url instanceof Request ? url.url : String(url)).pathname,init);
      const convexObservation = await inspectAccountWorkflow("convex",owner,{ WORKFLOW_POSTGRES_URL: workflow.url,
        CONVEX_SITE_URL: "https://test.convex.site",CONVEX_AUDIT_SECRET: auditSecret },convexRequest);
      expect(convexObservation).toMatchObject({ boundSessionCount: 2,
        linkedRuns: { runs: 4,terminalRuns: 3,nonterminalRuns: 1,events: 1,invocations: 1 },
        unattributedWorkflowRows: { runs: 2,events: 1,invocations: 2 },unattributedWorkflowRowCount: 5,otherSessionRoots: 1 });
      expect(JSON.stringify(convexObservation)).not.toContain(owner.tenant);
      expect(JSON.stringify(convexObservation)).not.toContain(owner.subject);

      const closure = await inspectAccountClosure("sqlite","local",owner,{
        AUTH_PROVIDER: "api-key",ACCOUNT_AUDIT_SQLITE_PATH: path,UPLOAD_LOCAL_ROOT: uploadRoot,
        WORKFLOW_POSTGRES_URL: workflow.url,
      },fetch,{ workflowPostgres: true });
      expect(closure).toMatchObject({ format: "ai-app-jumpstart-account-closure-observation-v4",
        status: "retained_or_unattributable",workflow: { provider: "postgres",boundSessionCount: 2,
          linkedRuns: { runs: 4,terminalRuns: 3,nonterminalRuns: 1,events: 1,invocations: 1 },
          unattributedRows: { runs: 2,events: 1,invocations: 2 },unattributedRowCount: 5 },
        remaining: { workflowRows: true,workflowUnattributedRows: 5 } });
      expect(JSON.stringify(closure)).not.toContain(owner.tenant);
      expect(JSON.stringify(closure)).not.toContain(owner.subject);
      const noLinkedOwner = await inspectAccountClosure("sqlite","local",{ ...owner,subject: "unbound-owner" },{
        AUTH_PROVIDER: "api-key",ACCOUNT_AUDIT_SQLITE_PATH: path,UPLOAD_LOCAL_ROOT: uploadRoot,
        WORKFLOW_POSTGRES_URL: workflow.url,
      },fetch,{ workflowPostgres: true });
      expect(noLinkedOwner).toMatchObject({ status: "retained_or_unattributable",
        remaining: { workflowRows: false,workflowUnattributedRows: 11 },
        workflow: { linkedRuns: { runs: 0 },unattributedRowCount: 11,otherSessionRoots: 2 } });
      const closureCommand = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/inspect-account-closure.ts",
        "--metadata","sqlite","--workflow-postgres","--read-only"],{
        cwd: process.cwd(),encoding: "utf8",env: { ...process.env,ACCOUNT_AUDIT_TENANT: owner.tenant,
          ACCOUNT_AUDIT_SUBJECT: owner.subject,ACCOUNT_AUDIT_SQLITE_PATH: path,AUTH_PROVIDER: "api-key",
          UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: uploadRoot,WORKFLOW_POSTGRES_URL: workflow.url,
        } });
      expect(closureCommand.status,closureCommand.stderr).toBe(0);
      expect(JSON.parse(closureCommand.stdout).workflow.linkedRuns.runs).toBe(4);
      expect(JSON.parse(closureCommand.stdout).remaining.workflowUnattributedRows).toBe(5);
      expect(closureCommand.stdout).not.toContain(owner.tenant);
      expect(closureCommand.stdout).not.toContain(owner.subject);
      const incompleteCommand = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/inspect-account-closure.ts",
        "--metadata","sqlite","--workflow-postgres","--read-only"],{
        cwd: process.cwd(),encoding: "utf8",env: { ...process.env,ACCOUNT_AUDIT_TENANT: owner.tenant,
          ACCOUNT_AUDIT_SUBJECT: owner.subject,ACCOUNT_AUDIT_SQLITE_PATH: path,AUTH_PROVIDER: "api-key",
          UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: uploadRoot,WORKFLOW_POSTGRES_URL: "",
        } });
      expect(incompleteCommand.status).toBe(1);
      expect(incompleteCommand.stdout).toBe("");
      expect(incompleteCommand.stderr).toContain("Account closure inspection failed.");
      expect(incompleteCommand.stderr).not.toContain(owner.tenant);
      expect(incompleteCommand.stderr).not.toContain(owner.subject);
    } finally { await pg.end(); }
  } finally { await workflow.stop();rmSync(dir,{ recursive: true,force: true }); }
},30_000);
