import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync,mkdirSync,readFileSync,rmSync,statSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { expect,it } from "vitest";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { exportAccountBundle } from "../../scripts/export-account-bundle";
import { exportAccountWorkflow,verifyAccountWorkflowExport } from "../../scripts/export-account-workflow";
import { setSqliteAccountFence } from "../../scripts/fence-account-writes";
import { workflowPostgresFixture } from "../../scripts/helpers/workflow-postgres-fixture.mjs";

it("preserves linked Workflow payloads in a private source-bound archive and rejects tampering",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-workflow-export-"));
  const app = join(dir,"app.sqlite"),objects = join(dir,"objects"),bundle = join(dir,"bundle"),archive = join(dir,"workflow.ndjson");
  const owner = { tenant: "private-workflow-tenant",subject: "private-workflow-user" };
  const database = await workflowPostgresFixture();
  try {
    mkdirSync(objects,{ mode: 0o700 });
    const stores = [new SqliteRepository(app),sqliteAccessStore(app),sqliteBudgetStore(app),
      sqliteUploadCatalog(app),sqlitePreferenceStore(app),sqliteRequestLimitStore(app)];
    for (const store of stores) await store.close();
    const sqlite = new DatabaseSync(app);
    try {
      const statement = sqlite.prepare(`INSERT INTO app_conversations
        (id,tenant,subject,operation_id,request_hash,session_id,status) VALUES (?,?,?,?,?,?,?)`);
      statement.run(crypto.randomUUID(),owner.tenant,owner.subject,crypto.randomUUID(),"a".repeat(64),"owned-session","active");
      statement.run(crypto.randomUUID(),owner.tenant,owner.subject,crypto.randomUUID(),"b".repeat(64),"retired-session","revoked");
      statement.run(crypto.randomUUID(),owner.tenant,"foreign-user",crypto.randomUUID(),"c".repeat(64),"foreign-session","active");
    } finally { sqlite.close(); }
    setSqliteAccountFence(app,owner);
    await exportAccountBundle("sqlite","local",owner,bundle,{ ACCOUNT_AUDIT_SQLITE_PATH: app,UPLOAD_LOCAL_ROOT: objects });
    const migration = spawnSync(process.execPath,["scripts/migrate-workflow.mjs"],{
      cwd: process.cwd(),encoding: "utf8",env: { ...process.env,WORKFLOW_POSTGRES_URL: database.url,
        WORKFLOW_POSTGRES_JOB_PREFIX: "account_export_test",EVE_WORKFLOW_PROVIDER: "postgres" } });
    expect(migration.status,migration.stderr).toBe(0);
    const pg = new Client({ connectionString: database.url });await pg.connect();
    try {
      for (const [id,attributes,marker] of [
        ["owned-session",{"$eve.type":"session"},"owned-private-checkpoint"],
        ["owned-turn",{"$eve.type":"turn","$eve.parent":"owned-session","$eve.root":"owned-session"},"owned-turn-payload"],
        ["retained-child",{"$eve.type":"turn","$eve.root":"retired-session"},"retained-after-root"],
        ["foreign-session",{"$eve.type":"session"},"foreign-private-checkpoint"],
      ] as const) await pg.query(`INSERT INTO workflow.workflow_runs (id,deployment_id,status,name,attributes,input)
        VALUES ($1,'fixture','completed','fixture',$2::jsonb,$3::jsonb)`,[id,JSON.stringify(attributes),JSON.stringify({ marker })]);
      await pg.query(`INSERT INTO workflow.workflow_events (id,type,run_id,payload_cbor)
        VALUES ('event-1','test','owned-turn',$1)`,[Buffer.from("owned-private-event")]);
    } finally { await pg.end(); }
    const result = await exportAccountWorkflow(bundle,archive,database.url,owner);
    expect(result).toMatchObject({ runs: 3,rows: 4,counts: { workflow_runs: 3,workflow_events: 1 } });
    expect(statSync(archive).mode & 0o077).toBe(0);
    const content = readFileSync(archive,"utf8");
    expect(content).toContain("owned-private-checkpoint");
    expect(content).toContain("retained-after-root");
    expect(content).toContain(Buffer.from("owned-private-event").toString("hex"));
    expect(content).not.toContain("foreign-private-checkpoint");
    expect(content).not.toContain(owner.subject);
    expect(await verifyAccountWorkflowExport(bundle,archive)).toMatchObject({ runs: 3,rows: 4 });
    await expect(exportAccountWorkflow(bundle,archive,database.url,owner)).rejects.toThrow();
    await expect(exportAccountWorkflow(bundle,join(dir,"wrong-owner.ndjson"),database.url,
      { ...owner,subject: "foreign-user" })).rejects.toThrow("does not match");
    const cli = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/export-account-workflow.ts",
      "--source",bundle,"--output",join(dir,"missing-stop.ndjson")],{ cwd: process.cwd(),encoding: "utf8",
      env: { ...process.env,WORKFLOW_POSTGRES_URL: database.url,ACCOUNT_AUDIT_TENANT: owner.tenant,
        ACCOUNT_AUDIT_SUBJECT: owner.subject } });
    expect(cli.status).toBe(2);
    expect(cli.stdout).toBe("");
    const cliArchive = join(dir,"cli-workflow.ndjson");
    const success = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/export-account-workflow.ts",
      "--source",bundle,"--output",cliArchive,"--stopped"],{ cwd: process.cwd(),encoding: "utf8",
      env: { ...process.env,WORKFLOW_POSTGRES_URL: database.url,ACCOUNT_AUDIT_TENANT: owner.tenant,
        ACCOUNT_AUDIT_SUBJECT: owner.subject } });
    expect(success.status,success.stderr).toBe(0);
    expect(JSON.parse(success.stdout).runs).toBe(3);
    expect(success.stdout).not.toContain(owner.subject);
    const offline = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/export-account-workflow.ts",
      "--source",bundle,"--archive",cliArchive],{ cwd: process.cwd(),encoding: "utf8",
      env: { ...process.env,WORKFLOW_POSTGRES_URL: "",ACCOUNT_AUDIT_TENANT: "",ACCOUNT_AUDIT_SUBJECT: "" } });
    expect(offline.status,offline.stderr).toBe(0);
    expect(JSON.parse(offline.stdout)).toMatchObject({ runs: 3,rows: 4 });
    writeFileSync(archive,content.replace("owned-private-checkpoint","changed-private-checkpoint"),{ mode: 0o600 });
    await expect(verifyAccountWorkflowExport(bundle,archive)).rejects.toThrow("digest or counts differ");
  } finally { await database.stop();rmSync(dir,{ recursive: true,force: true }); }
},30_000);
