import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
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
import { eraseAccountWorkflow } from "../../scripts/erase-account-workflow";
import { rehearseAccountWorkflow } from "../../scripts/rehearse-account-workflow";
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
      await pg.query(`INSERT INTO workflow.workflow_events (id,type,run_id,payload_cbor)
        SELECT 'paged-event-' || n,'test','owned-turn',decode('00','hex')
        FROM generate_series(1,105) AS n`);
      await pg.query(`INSERT INTO workflow.workflow_steps
        (run_id,step_id,step_name,status,input,output,attempt)
        VALUES ('owned-turn','step-1','fixture','completed','{}'::jsonb,'{"private":"step"}'::jsonb,1)`);
      await pg.query(`INSERT INTO workflow.workflow_hooks
        (run_id,hook_id,token,owner_id,project_id,environment,metadata)
        VALUES ('owned-turn','hook-1','fixture-private-token','owner','project','test','{}'::jsonb)`);
      await pg.query(`INSERT INTO workflow.workflow_stream_chunks
        (id,stream_id,data,eof,run_id) VALUES ('chunk-1','stream-1',$1,true,'owned-turn')`,
        [Buffer.from("owned-private-stream")]);
      await pg.query(`INSERT INTO workflow.workflow_waits (wait_id,run_id,status)
        VALUES ('wait-1','owned-turn','completed')`);
      await pg.query(`INSERT INTO workflow.workflow_event_slots (run_id) VALUES ('owned-turn')`);
      await pg.query(`INSERT INTO workflow.workflow_invocations (run_id,request_id,payload,fingerprint,result)
        VALUES ('owned-turn','invocation-1',$1,'fixture-fingerprint',$2),
          ('foreign-session','invocation-2',$3,'foreign-fingerprint',$4)`,
        [Buffer.from("owned-private-invocation-payload"),Buffer.from("owned-private-invocation-result"),
          Buffer.from("foreign-private-invocation-payload"),Buffer.from("foreign-private-invocation-result")]);
    } finally { await pg.end(); }
    const result = await exportAccountWorkflow(bundle,archive,database.url,owner,"account_export_test");
    expect(result).toMatchObject({ runs: 3,rows: 115,counts: { workflow_runs: 3,workflow_events: 106,
      workflow_steps: 1,workflow_hooks: 1,workflow_stream_chunks: 1,workflow_waits: 1,workflow_event_slots: 1,
      workflow_invocations: 1 } });
    expect(statSync(archive).mode & 0o077).toBe(0);
    const content = readFileSync(archive,"utf8");
    expect(content).toContain("owned-private-checkpoint");
    expect(content).toContain("retained-after-root");
    expect(content).toContain(Buffer.from("owned-private-event").toString("hex"));
    expect(content).toContain(Buffer.from("owned-private-stream").toString("hex"));
    expect(content).toContain(Buffer.from("owned-private-invocation-payload").toString("hex"));
    expect(content).toContain(Buffer.from("owned-private-invocation-result").toString("hex"));
    expect(content).not.toContain("foreign-private-checkpoint");
    expect(content).not.toContain("foreign-private-invocation-payload");
    expect(content).not.toContain(owner.subject);
    expect(await verifyAccountWorkflowExport(bundle,archive)).toMatchObject({ runs: 3,rows: 115 });
    if (process.platform !== "win32") {
      const fifo = join(dir,"workflow.fifo"),created = spawnSync("mkfifo",[fifo],{ encoding: "utf8" });
      expect(created.status,created.stderr).toBe(0);
      const rejected = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/export-account-workflow.ts",
        "--source",bundle,"--archive",fifo],{ cwd: process.cwd(),encoding: "utf8",timeout: 5000 });
      expect(rejected.error).toBeUndefined();
      expect(rejected.status).toBe(1);
    }
    const archiveLines = content.trimEnd().split("\n"),footer = JSON.parse(archiveLines.pop()!) as {
      value: { rows: number;counts: Record<string,number>;contentSha256: string };
    };
    const legacyBody = archiveLines.flatMap(line => {
      const item = JSON.parse(line) as { type: string;value?: { format?: string;table?: string } };
      if (item.type === "row" && item.value?.table === "workflow_invocations") return [];
      if (item.type === "manifest" && item.value) item.value.format = "ai-app-jumpstart-workflow-rows-v1";
      return [item.type === "manifest" ? JSON.stringify(item) : line];
    });
    footer.value.rows = 114;
    delete footer.value.counts.workflow_invocations;
    footer.value.contentSha256 = createHash("sha256").update(legacyBody.map(line => `${line}\n`).join("")).digest("hex");
    const legacyArchive = join(dir,"workflow-v1.ndjson");
    writeFileSync(legacyArchive,[...legacyBody,JSON.stringify(footer)].join("\n")+"\n",{ mode: 0o600 });
    expect(await verifyAccountWorkflowExport(bundle,legacyArchive)).toMatchObject({
      runs: 3,rows: 114,counts: { workflow_invocations: 0 },
    });
    await database.createDatabase("workflow_account_rehearsal_fixture");
    const rehearsalUrl = new URL(database.url);
    rehearsalUrl.pathname = "/workflow_account_rehearsal_fixture";
    const target = rehearsalUrl.toString();
    const targetMigration = spawnSync(process.execPath,["scripts/migrate-workflow.mjs"],{
      cwd: process.cwd(),encoding: "utf8",env: { ...process.env,WORKFLOW_POSTGRES_URL: target,
        WORKFLOW_POSTGRES_JOB_PREFIX: "account_rehearsal_test",EVE_WORKFLOW_PROVIDER: "postgres" } });
    expect(targetMigration.status,targetMigration.stderr).toBe(0);
    expect(await rehearseAccountWorkflow(bundle,archive,target)).toEqual({
      workflowProvider: "postgres",runs: 3,rows: 115,status: "rolled-back-rehearsal",
    });
    const rehearsalCli = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs",
      "scripts/rehearse-account-workflow.ts","--source",bundle,"--archive",archive],{
      cwd: process.cwd(),encoding: "utf8",env: { ...process.env,ACCOUNT_REHEARSAL_WORKFLOW_URL: target },
    });
    expect(rehearsalCli.status,rehearsalCli.stderr).toBe(0);
    expect(JSON.parse(rehearsalCli.stdout)).toMatchObject({ runs: 3,rows: 115,status: "rolled-back-rehearsal" });
    expect(rehearsalCli.stdout).not.toContain(owner.subject);
    const targetDb = new Client({ connectionString: target });await targetDb.connect();
    try {
      const counts = await targetDb.query("SELECT count(*)::int AS runs FROM workflow.workflow_runs");
      expect(counts.rows[0].runs).toBe(0);
      await targetDb.query(`INSERT INTO workflow.workflow_runs (id,deployment_id,status,name,input)
        VALUES ('existing','fixture','completed','fixture','{}'::jsonb)`);
      await expect(rehearseAccountWorkflow(bundle,archive,target)).rejects.toThrow("not empty");
      await targetDb.query("DELETE FROM workflow.workflow_runs WHERE id='existing'");
      const migration = await targetDb.query<{ hash: string }>(`SELECT hash FROM workflow_drizzle.workflow_migrations
        ORDER BY id DESC LIMIT 1`);
      await targetDb.query(`UPDATE workflow_drizzle.workflow_migrations SET hash='wrong'
        WHERE id=(SELECT max(id) FROM workflow_drizzle.workflow_migrations)`);
      await expect(rehearseAccountWorkflow(bundle,archive,target)).rejects.toThrow("migrations differ");
      await targetDb.query(`UPDATE workflow_drizzle.workflow_migrations SET hash=$1
        WHERE id=(SELECT max(id) FROM workflow_drizzle.workflow_migrations)`,[migration.rows[0].hash]);
    } finally { await targetDb.end(); }
    await expect(rehearseAccountWorkflow(bundle,archive,database.url)).rejects.toThrow("disposable loopback");
    await expect(exportAccountWorkflow(bundle,archive,database.url,owner,"account_export_test")).rejects.toThrow();
    await expect(exportAccountWorkflow(bundle,join(dir,"wrong-owner.ndjson"),database.url,
      { ...owner,subject: "foreign-user" },"account_export_test")).rejects.toThrow("does not match");
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
        ACCOUNT_AUDIT_SUBJECT: owner.subject,WORKFLOW_POSTGRES_JOB_PREFIX: "account_export_test" } });
    expect(success.status,success.stderr).toBe(0);
    expect(JSON.parse(success.stdout).runs).toBe(3);
    expect(success.stdout).not.toContain(owner.subject);
    const offline = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/export-account-workflow.ts",
      "--source",bundle,"--archive",cliArchive],{ cwd: process.cwd(),encoding: "utf8",
      env: { ...process.env,WORKFLOW_POSTGRES_URL: "",ACCOUNT_AUDIT_TENANT: "",ACCOUNT_AUDIT_SUBJECT: "" } });
    expect(offline.status,offline.stderr).toBe(0);
    expect(JSON.parse(offline.stdout)).toMatchObject({ runs: 3,rows: 115 });
    const jobPrefix = "account_export_test",pendingArchive = join(dir,"workflow-pending.ndjson");
    const pendingDb = new Client({ connectionString: database.url });await pendingDb.connect();
    try { await pendingDb.query("UPDATE workflow.workflow_runs SET status='running' WHERE id='owned-turn'"); }
    finally { await pendingDb.end(); }
    await exportAccountWorkflow(bundle,pendingArchive,database.url,owner,jobPrefix);
    await expect(eraseAccountWorkflow(bundle,pendingArchive,owner,database.url,jobPrefix))
      .rejects.toThrow("nonterminal runs");
    const queueDb = new Client({ connectionString: database.url });await queueDb.connect();
    try {
      await queueDb.query("UPDATE workflow.workflow_runs SET status='completed' WHERE id='owned-turn'");
      for (const [task,payload,queue] of [
        ["account_export_testflows_executor",{ runId: "owned-turn" },"account_export_testflows:owned-turn:executor"],
        ["account_export_testflows",{ runId: "owned-turn",stepId: "step-1" },null],
        ["account_export_testflows_executor",{ runId: "foreign-session" },"account_export_testflows:foreign-session:executor"],
        ["account_export_testflows",{ healthCheck: true },null],
      ] as const) await queueDb.query("SELECT graphile_worker.add_job($1,$2::json,$3)",
        [task,JSON.stringify(payload),queue]);
      await queueDb.query("SELECT graphile_worker.add_job($1,$2::json,$3)",[
        "account_export_testflows",JSON.stringify({ __healthCheck: true,correlationId: "pending-start",runId: "owned-turn" }),null,
      ]);
    } finally { await queueDb.end(); }
    await expect(eraseAccountWorkflow(bundle,archive,owner,database.url,jobPrefix))
      .rejects.toThrow("pending Workflow start check");
    const clearStartCheckDb = new Client({ connectionString: database.url });await clearStartCheckDb.connect();
    try { await clearStartCheckDb.query(`DELETE FROM graphile_worker._private_jobs WHERE
      task_id=(SELECT id FROM graphile_worker._private_tasks WHERE identifier='account_export_testflows')
        AND payload->>'__healthCheck'='true' AND payload->>'runId'='owned-turn'`); }
    finally { await clearStartCheckDb.end(); }
    await expect(eraseAccountWorkflow(bundle,archive,owner,database.url,"other_environment"))
      .rejects.toThrow("matching owner and source-bound v2 archive");
    await expect(eraseAccountWorkflow(bundle,archive,owner,database.url,jobPrefix)).resolves.toMatchObject({
      runs: 3,rows: 115,jobs: 2,queues: 1,deletedRows: 0,deletedJobs: 0,deletedQueues: 0,
      status: "linked-workflow-state-erasure-planned",
    });
    const eraseEnv = { ...process.env,WORKFLOW_POSTGRES_URL: database.url,WORKFLOW_POSTGRES_JOB_PREFIX: jobPrefix,
      ACCOUNT_AUDIT_TENANT: owner.tenant,ACCOUNT_AUDIT_SUBJECT: owner.subject };
    const missingConfirm = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/erase-account-workflow.ts",
      "--source",bundle,"--archive",archive,"--stopped","--erase-workflow-state"],{
      cwd: process.cwd(),encoding: "utf8",env: eraseEnv,
    });
    expect(missingConfirm.status).toBe(2);
    const erasePlan = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/erase-account-workflow.ts",
      "--source",bundle,"--archive",archive,"--stopped","--plan"],{
      cwd: process.cwd(),encoding: "utf8",env: eraseEnv,
    });
    expect(erasePlan.status,erasePlan.stderr).toBe(0);
    expect(JSON.parse(erasePlan.stdout)).toMatchObject({ rows: 115,jobs: 2,status: "linked-workflow-state-erasure-planned" });
    expect(erasePlan.stdout).not.toContain(owner.subject);
    const exactDb = new Client({ connectionString: database.url });await exactDb.connect();
    try { await exactDb.query("UPDATE workflow.workflow_steps SET output=$1::jsonb WHERE run_id='owned-turn'",
      [JSON.stringify({ changed: true })]); }
    finally { await exactDb.end(); }
    await expect(eraseAccountWorkflow(bundle,archive,owner,database.url,jobPrefix)).rejects.toThrow("rows differ");
    const restoreDb = new Client({ connectionString: database.url });await restoreDb.connect();
    try {
      await restoreDb.query("UPDATE workflow.workflow_steps SET output=$1::jsonb WHERE run_id='owned-turn'",
        [JSON.stringify({ private: "step" })]);
      await restoreDb.query(`UPDATE graphile_worker._private_jobs SET locked_by='stopped-worker',locked_at=now()
        WHERE task_id=(SELECT id FROM graphile_worker._private_tasks WHERE identifier='account_export_testflows_executor')
          AND job_queue_id=(SELECT id FROM graphile_worker._private_job_queues
            WHERE queue_name='account_export_testflows:owned-turn:executor')`);
    } finally { await restoreDb.end(); }
    await expect(eraseAccountWorkflow(bundle,archive,owner,database.url,jobPrefix))
      .rejects.toThrow("still hold run-linked jobs");
    const unlockDb = new Client({ connectionString: database.url });await unlockDb.connect();
    try { await unlockDb.query("UPDATE graphile_worker._private_jobs SET locked_by=NULL,locked_at=NULL WHERE locked_by='stopped-worker'"); }
    finally { await unlockDb.end(); }
    await expect(eraseAccountWorkflow(bundle,archive,owner,database.url,jobPrefix,true)).resolves.toMatchObject({
      runs: 3,rows: 115,jobs: 2,queues: 1,deletedRows: 115,deletedJobs: 2,deletedQueues: 1,
      status: "linked-workflow-state-erased",
    });
    const afterEraseDb = new Client({ connectionString: database.url });await afterEraseDb.connect();
    try {
      const owned = await afterEraseDb.query("SELECT count(*)::int AS count FROM workflow.workflow_runs WHERE id=ANY($1::text[])",
        [["owned-session","owned-turn","retained-child"]]);
      const foreign = await afterEraseDb.query("SELECT count(*)::int AS count FROM workflow.workflow_runs WHERE id='foreign-session'");
      const ownedJobs = await afterEraseDb.query(`SELECT count(*)::int AS count FROM graphile_worker._private_jobs jobs
        JOIN graphile_worker._private_tasks tasks ON tasks.id=jobs.task_id
        LEFT JOIN graphile_worker._private_job_queues queues ON queues.id=jobs.job_queue_id
        WHERE queues.queue_name='account_export_testflows:owned-turn:executor' OR
          (tasks.identifier='account_export_testflows' AND jobs.payload->>'runId'='owned-turn')`);
      const foreignJob = await afterEraseDb.query("SELECT count(*)::int AS count FROM graphile_worker.jobs WHERE queue_name='account_export_testflows:foreign-session:executor'");
      const healthJob = await afterEraseDb.query(`SELECT count(*)::int AS count FROM graphile_worker._private_jobs jobs
        JOIN graphile_worker._private_tasks tasks ON tasks.id=jobs.task_id
        WHERE tasks.identifier='account_export_testflows' AND jobs.payload->>'healthCheck'='true'`);
      const ownedQueues = await afterEraseDb.query(`SELECT count(*)::int AS count FROM graphile_worker._private_job_queues
        WHERE queue_name='account_export_testflows:owned-turn:executor'`);
      expect(owned.rows[0].count).toBe(0);
      expect(foreign.rows[0].count).toBe(1);
      expect(ownedJobs.rows[0].count).toBe(0);
      expect(foreignJob.rows[0].count).toBe(1);
      expect(healthJob.rows[0].count).toBe(1);
      expect(ownedQueues.rows[0].count).toBe(0);
    } finally { await afterEraseDb.end(); }
    writeFileSync(archive,content.replace("owned-private-checkpoint","changed-private-checkpoint"),{ mode: 0o600 });
    await expect(verifyAccountWorkflowExport(bundle,archive)).rejects.toThrow("digest or counts differ");
    await expect(rehearseAccountWorkflow(bundle,archive,target)).rejects.toThrow("digest or counts differ");
  } finally { await database.stop();rmSync(dir,{ recursive: true,force: true }); }
},90_000);
