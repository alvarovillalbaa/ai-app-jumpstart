import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect,it } from "vitest";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { inspectAccountWorkflow } from "../../scripts/inspect-account-workflow.mjs";
import { workflowPostgresFixture } from "../../scripts/helpers/workflow-postgres-fixture.mjs";

it("counts only native Workflow runs linked to an owner's bound session and hides account identifiers",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-workflow-inspection-"));
  const path = join(dir,"app.sqlite"),workflow = await workflowPostgresFixture();
  const owner = { tenant: "private-tenant",subject: "private-subject" };
  try {
    const store = sqliteAccessStore(path);await store.close();
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
      for (const [id,attributes] of [
        ["owned-session",{"$eve.type":"session"}],
        ["owned-turn",{"$eve.type":"turn","$eve.parent":"owned-session","$eve.root":"owned-session"}],
        ["owned-child",{"$eve.type":"subagent","$eve.parent":"owned-turn"}],
        ["retained-child",{"$eve.type":"turn","$eve.parent":"retired-session","$eve.root":"retired-session"}],
        ["other-session",{"$eve.type":"session"}],
      ] as const) await pg.query(`INSERT INTO workflow.workflow_runs (id,deployment_id,status,name,attributes)
        VALUES ($1,'fixture','completed','fixture',$2::jsonb)`,[id,JSON.stringify(attributes)]);
      await pg.query(`INSERT INTO workflow.workflow_events (id,type,run_id) VALUES ('event-1','test','owned-turn')`);
      const env = { ACCOUNT_AUDIT_SQLITE_PATH: path,WORKFLOW_POSTGRES_URL: workflow.url };
      const observed = await inspectAccountWorkflow("sqlite",owner,env);
      expect(observed).toMatchObject({ boundSessionCount: 2,
        linkedRuns: { runs: 4,events: 1 },otherSessionRoots: 1 });
      expect(JSON.stringify(observed)).not.toContain(owner.tenant);
      expect(JSON.stringify(observed)).not.toContain(owner.subject);
      expect(await inspectAccountWorkflow("sqlite",{ ...owner,subject: "missing" },env)).toMatchObject({
        boundSessionCount: 0,linkedRuns: { runs: 0 },otherSessionRoots: 2 });
      await pg.query(`CREATE TABLE public.app_conversations
        (tenant text NOT NULL,subject text NOT NULL,session_id text)`);
      await pg.query(`INSERT INTO public.app_conversations (tenant,subject,session_id) VALUES ($1,$2,'owned-session')`,
        [owner.tenant,owner.subject]);
      expect(await inspectAccountWorkflow("postgres",owner,{ DATABASE_URL: workflow.url,
        WORKFLOW_POSTGRES_URL: workflow.url })).toMatchObject({ boundSessionCount: 1,linkedRuns: { runs: 3,events: 1 } });
      const command = spawnSync(process.execPath,["scripts/inspect-account-workflow.mjs","--metadata","sqlite","--read-only"],{
        cwd: process.cwd(),encoding: "utf8",env: { ...process.env,...env,ACCOUNT_AUDIT_TENANT: owner.tenant,
          ACCOUNT_AUDIT_SUBJECT: owner.subject } });
      expect(command.status,command.stderr).toBe(0);
      expect(JSON.parse(command.stdout).linkedRuns.runs).toBe(4);
      expect(command.stdout).not.toContain(owner.subject);
    } finally { await pg.end(); }
  } finally { await workflow.stop();rmSync(dir,{ recursive: true,force: true }); }
});
