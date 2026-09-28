import EmbeddedPostgres from "embedded-postgres";
import { appendFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { SignJWT } from "jose";
import { Client } from "pg";
import assert from "node:assert/strict";
import { installPostgrest } from "./testing/postgrest.mjs";
import { backupPostgresApplication, backupPostgresWorkflow } from "./backup-postgres.mjs";
import { createPostgresDatabaseSet, restorePostgresUploadSnapshot, verifyPostgresDatabaseSet } from "./backup-postgres-databases.mjs";
import { checkSnapshotUploadCatalog, describeUploadSnapshot } from "./private-upload-snapshot.mjs";
import { accountOrphanCountQueries,accountOwnerCountQueries } from "./account-data-inventory.mjs";
import { inspectPostgresAccountData } from "./inspect-account-data.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const withSupabase = process.argv.includes("--supabase");
const backupOnly = process.argv.includes("--backup-only");
const directory = await mkdtemp(join(tmpdir(), "jumpstart-postgres-"));
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise(resolve => listener.close(resolve));
const password = randomBytes(24).toString("hex");
const database = new EmbeddedPostgres({
  databaseDir: join(directory, "data"), user: "jumpstart", password, port,
  persistent: true, authMethod: "scram-sha-256", createPostgresUser: false,
  postgresFlags: ["-h", "127.0.0.1", "-k", directory],
  onLog: () => {}, onError: () => {},
});
const env = { ...process.env, DATA_PROVIDER: "postgres", DATABASE_URL: `postgresql://jumpstart:${password}@127.0.0.1:${port}/app_test` };
let child;
let postgrest;
let proxy;
let restDiagnostics = "";
let validationFailed = false;
let stopping = false;
async function run(args, expectedCode = 0, commandEnv = env) {
  child = spawn(process.execPath, args, { cwd: root, env: commandEnv, stdio: expectedCode === 0 ? "inherit" : "ignore" });
  const [code, signal] = await once(child, "exit");
  child = undefined;
  if (code !== expectedCode || signal) throw new Error(`Database validation failed (${signal ?? code}, expected ${expectedCode}).`);
}
async function rehearseMigrationLedgerSearchPath() {
  const migrationCount = (await readdir(join(root,"migrations"))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).length;
  for (const legacy of [false,true]) {
    const name = legacy ? "app_legacy_ledger_test" : "app_search_path_test";
    await database.createDatabase(name);
    const url = env.DATABASE_URL.replace(/\/app_test$/,`/${name}`);
    const setup = new Client({ connectionString: url });
    await setup.connect();
    try {
      await setup.query("CREATE SCHEMA auth");
      if (legacy) await setup.query("CREATE TABLE auth.app_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      await setup.query(`ALTER DATABASE ${name} SET search_path = auth, public`);
    } finally { await setup.end(); }
    await run(["scripts/migrate.ts"],0,{ ...env,DATABASE_URL: url });
    await run(["scripts/migrate.ts","--dry-run"],0,{ ...env,DATABASE_URL: url });
    const verify = new Client({ connectionString: url });
    await verify.connect();
    try {
      assert.equal((await verify.query("SELECT to_regclass('public.app_migrations')::text AS name")).rows[0].name,
        legacy ? null : "app_migrations");
      assert.equal((await verify.query("SELECT to_regclass('auth.app_migrations')::text AS name")).rows[0].name,
        legacy ? "app_migrations" : null);
      const ledger = legacy ? "auth.app_migrations" : "public.app_migrations";
      assert.equal(Number((await verify.query(`SELECT count(*) AS count FROM ${ledger}`)).rows[0].count),migrationCount);
      assert.equal((await verify.query("SELECT to_regclass('public.app_records')::text AS name")).rows[0].name,
        "app_records");
      if (legacy) {
        await verify.query("CREATE TABLE public.app_migrations (name text PRIMARY KEY)");
        await run(["scripts/migrate.ts","--dry-run"],1,{ ...env,DATABASE_URL: url });
        await verify.query("DROP TABLE public.app_migrations");
      }
    } finally { await verify.end(); }
  }
}
async function rehearseUpgrade() {
  // No release tag exists yet. This frozen migration boundary represents a
  // populated schema before the source-index and checkpoint upgrades.
  const baseline = "20260924233000_upload_cleanup_index.sql";
  const names = (await readdir(join(root, "migrations"))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  const boundary = names.indexOf(baseline);
  assert.ok(boundary >= 0 && boundary < names.length - 1, "Upgrade baseline must precede current migrations");
  await database.createDatabase("app_upgrade_test");
  const upgradeEnv = { ...env, DATABASE_URL: env.DATABASE_URL.replace(/\/app_test$/, "/app_upgrade_test") };
  const probe = new Client({ connectionString: upgradeEnv.DATABASE_URL });
  await probe.connect();
  const recordId = randomUUID();
  const conversationId = randomUUID();
  const operationId = randomUUID();
  const uploadId = randomUUID(),deletedUploadId = randomUUID(),artifactId = randomUUID(),deletedArtifactId = randomUUID();
  const eventId = `evt_${"0".repeat(26)}`;
  const event = JSON.stringify({
    schemaVersion: 1, eventId, at: "2026-09-24T00:00:00.000Z", turnId: "upgrade-turn", sequence: 0,
    payload: { kind: "message", role: "user", parts: [{ type: "text", text: "Preserved across upgrade" }] },
  });
  try {
    await probe.query("BEGIN");
    if (withSupabase) await probe.query(`CREATE SCHEMA storage;
      CREATE TABLE storage.objects (bucket_id text NOT NULL, name text NOT NULL, PRIMARY KEY(bucket_id,name));
      ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
      CREATE POLICY test_broad_storage ON storage.objects FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
      GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
      INSERT INTO storage.objects(bucket_id,name) VALUES ('app-private-uploads','existing-private-object');`);
    await probe.query("CREATE TABLE app_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    for (const name of names.slice(0, boundary + 1)) {
      await probe.query(await readFile(join(root, "migrations", name), "utf8"));
      await probe.query("INSERT INTO app_migrations(name) VALUES($1)", [name]);
    }
    await probe.query("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,$2,$3,$4,$5)",
      [recordId, "upgrade-tenant", "upgrade-owner", "Before upgrade", "Keep this private record"]);
    await probe.query(`INSERT INTO app_conversations(id,tenant,subject,operation_id,request_hash,session_id,status,title,created_at)
      VALUES($1,$2,$3,$4,$5,$6,'active',$7,$8)`,
      [conversationId, "upgrade-tenant", "upgrade-owner", operationId, "a".repeat(64), "upgrade-session", "Before upgrade", 1]);
    await probe.query(`INSERT INTO app_artifacts(id,operation_id,session_id,call_id,input_hash,title,content,created_at,deleted_at)
      VALUES($1,$3,'upgrade-session','retained',$4,'Before upgrade','Retained approved text',10,NULL),
        ($2,$3,'upgrade-session','deleted',$4,'Deleted artifact',' ',11,12)`,[artifactId,deletedArtifactId,operationId,"a".repeat(64)]);
    await probe.query("INSERT INTO app_conversation_events(operation_id,event_id,payload) VALUES($1,$2,$3)", [operationId, eventId, event]);
    const runEvent = JSON.stringify({ schemaVersion: 1,eventId: `evt_${"1".repeat(26)}`,at: "2026-09-24T00:00:01.000Z",
      turnId: "upgrade-turn",sequence: 0,payload: { kind: "run",state: "completed" } });
    await probe.query("INSERT INTO app_conversation_events(operation_id,event_id,payload) VALUES($1,$2,$3)",[operationId,`evt_${"1".repeat(26)}`,runEvent]);
    await probe.query(`INSERT INTO app_uploads(id,tenant,subject,name,media_type,size,sha256,created_at,state)
      VALUES($1,'upgrade-tenant','upgrade-owner','before.txt','text/plain',10,$3,1,'quarantined'),
      ($2,'upgrade-tenant','upgrade-owner','deleted.txt','text/plain',20,$3,2,'deleted')`,[uploadId,deletedUploadId,"a".repeat(64)]);
    await probe.query("COMMIT");

    const appliedBefore = await probe.query("SELECT count(*)::int AS count FROM app_migrations");
    assert.equal(appliedBefore.rows[0].count, boundary + 1);
    assert.equal((await probe.query("SELECT 1 FROM information_schema.columns WHERE table_name='app_conversation_events' AND column_name='source_index'")).rowCount, 0);
    await run(["scripts/migrate.ts", "--dry-run"], 0, upgradeEnv);
    assert.equal((await probe.query("SELECT count(*)::int AS count FROM app_migrations")).rows[0].count, boundary + 1,
      "Upgrade dry-run changed the migration ledger");
    assert.equal((await probe.query("SELECT 1 FROM information_schema.columns WHERE table_name='app_conversation_events' AND column_name='source_index'")).rowCount, 0,
      "Upgrade dry-run changed the event schema");
    await run(["scripts/migrate.ts"], 0, upgradeEnv);
    await run(["scripts/migrate.ts"], 0, upgradeEnv);
    await run(["scripts/migrate.ts", "--dry-run"], 0, upgradeEnv);
    assert.equal((await probe.query("SELECT count(*)::int AS count FROM app_migrations")).rows[0].count, names.length);
    await probe.query("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,$2,$3,$4,$5)",
      [randomUUID(),"upgrade-tenant","other-owner","Other owner","Private to them"]);
    async function ownerCounts(subject) {
      const counts = [];
      for (const query of accountOwnerCountQueries("sql"))
        counts.push([query.entity,Number((await probe.query(query.sql,["upgrade-tenant",subject])).rows[0].count)]);
      return Object.fromEntries(counts);
    }
    const retainedCounts = await ownerCounts("upgrade-owner");
    assert.deepEqual({
      records: retainedCounts.records,conversations: retainedCounts.conversations,
      artifacts: retainedCounts.artifacts,artifactVersions: retainedCounts.artifactVersions,
      uploads: retainedCounts.uploads,
    },{ records: 1,conversations: 1,artifacts: 2,artifactVersions: 1,uploads: 2 },
    "Owner inventory omitted retained SQL rows or tombstones");
    const foreignCounts = await ownerCounts("other-owner");
    assert.equal(foreignCounts.records,1);
    assert.ok(Object.entries(foreignCounts).filter(([entity]) => entity !== "records").every(([,count]) => count === 0),
      "Owner inventory crossed SQL accounts");
    for (const query of accountOrphanCountQueries("sql"))
      assert.equal(Number((await probe.query(query.sql)).rows[0].count),0,`Unattributable ${query.entity} rows in the migrated schema`);
    const inspection = await inspectPostgresAccountData(upgradeEnv.DATABASE_URL,"upgrade-tenant","upgrade-owner");
    assert.equal(inspection.ownerRows.records,1);
    assert.equal(inspection.ownerRows.artifacts,2);
    assert.equal(inspection.ownerRows.uploads,2);
    assert.equal(inspection.orphanRowTotal,0);
    const closure = spawn(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/inspect-account-closure.ts",
      "--metadata","postgres","--read-only"],{ cwd: root,env: { ...upgradeEnv,
        ACCOUNT_AUDIT_TENANT: "upgrade-tenant",ACCOUNT_AUDIT_SUBJECT: "upgrade-owner",
        UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: directory },stdio: ["ignore","pipe","ignore"] });
    let closureOutput = "";
    closure.stdout.on("data",chunk => { closureOutput += chunk.toString(); });
    const [closureCode,closureSignal] = await once(closure,"exit");
    if (closureCode !== 0 || closureSignal) throw new Error("PostgreSQL closure observation failed.");
    const closureReport = JSON.parse(closureOutput);
    assert.equal(closureReport.metadataProvider,"postgres");
    assert.equal(closureReport.ownerRows.records,1);
    assert.equal(closureReport.objectCount,0);
    assert.equal(closureReport.status,"retained_or_unattributable");
    assert.deepEqual((await probe.query("SELECT revision,title,content,updated_at FROM app_artifact_versions WHERE artifact_id=$1",[artifactId])).rows,
      [{ revision: 1,title: "Before upgrade",content: "Retained approved text",updated_at: "10" }]);
    assert.equal((await probe.query("SELECT count(*)::int AS count FROM app_artifact_versions WHERE artifact_id=$1",[deletedArtifactId])).rows[0].count,0);
    assert.deepEqual((await probe.query("SELECT title,content,revision FROM app_records WHERE id=$1", [recordId])).rows[0],
      { title: "Before upgrade", content: "Keep this private record", revision: 1 });
    assert.deepEqual((await probe.query("SELECT tenant,subject,status,projection_checkpoint FROM app_conversations WHERE operation_id=$1", [operationId])).rows[0],
      { tenant: "upgrade-tenant", subject: "upgrade-owner", status: "active", projection_checkpoint: "0" });
    assert.deepEqual((await probe.query("SELECT payload,source_index FROM app_conversation_events WHERE event_id=$1", [eventId])).rows[0],
      { payload: event, source_index: null });
    const runCache = JSON.parse((await probe.query("SELECT payload FROM app_conversation_runs WHERE operation_id=$1",[operationId])).rows[0].payload);
    assert.equal(runCache.summary.boundaryCount,1,"Retained run boundary was not backfilled");
    assert.equal(runCache.summary.unindexedFacts,1,"Backfill invented source coverage");
    assert.deepEqual(runCache.summary.models,[],"Backfill invented model information");
    if (withSupabase) await probe.query("SET ROLE service_role");
    try {
      assert.equal((await probe.query("SELECT app_update_artifact($1,$2,$3,1,$4,$5,20) AS result",
        ["upgrade-tenant","upgrade-owner",artifactId,"Edited after upgrade","New version"])).rows[0].result.status,"updated");
      assert.equal((await probe.query("SELECT count(*)::int AS count FROM app_artifact_versions WHERE artifact_id=$1",[artifactId])).rows[0].count,2);
      assert.equal((await probe.query("SELECT app_delete_artifact($1,$2,$3,30) AS result",["upgrade-tenant","upgrade-owner",artifactId])).rows[0].result,true);
      assert.equal((await probe.query("SELECT count(*)::int AS count FROM app_artifact_versions WHERE artifact_id=$1",[artifactId])).rows[0].count,0);
      const owner = { tenant: "upgrade-tenant",subject: "upgrade-owner",id: uploadId };
      const scan = async (status,checkedAt,reason) => (await probe.query("SELECT app_upload_scan_command('record',$1) AS result",[
        { ...owner,decision: { status,sha256: "a".repeat(64),checkedAt,policyVersion: 1,...(reason ? { reason } : {}) } },
      ])).rows[0].result;
      assert.deepEqual((await probe.query("SELECT id,state FROM app_uploads WHERE id IN ($1,$2) ORDER BY created_at",[uploadId,deletedUploadId])).rows,
        [{ id: uploadId,state: "quarantined" },{ id: deletedUploadId,state: "deleted" }]);
      assert.equal((await probe.query("SELECT app_upload_review_command('getReview',$1) AS result",[owner])).rows[0].result.status,"unreviewed");
      assert.equal((await probe.query("SELECT count(*)::int AS count FROM app_upload_reviews WHERE upload_id=$1",[uploadId])).rows[0].count,0,"A readonly review query created a consent row");
      assert.equal(await scan("clean",10),true);
      assert.equal((await probe.query("SELECT app_upload_review_command('recordReview',$1) AS result",[{ ...owner,decision: { revision: 0,sha256: "a".repeat(64),approved: true,at: 11,checkedAt: 10 } }])).rows[0].result.review.status,"approved");
      // An older binary reads the persisted new state and denies release.
      assert.equal((await probe.query("SELECT app_upload_command('get',$1) AS result",[owner])).rows[0].result.state,"clean");
      assert.equal(await scan("rejected",11,"malware"),true);
      assert.deepEqual((await probe.query("SELECT approved_sha256,approved_at,checked_at FROM app_upload_reviews WHERE upload_id=$1",[uploadId])).rows[0],
        { approved_sha256: null,approved_at: null,checked_at: null });
      assert.equal((await probe.query("SELECT app_upload_review_command('getReview',$1) AS result",[owner])).rows[0].result.status,"revoked");
      assert.equal(await scan("clean",12),false);
      assert.equal((await probe.query("SELECT app_upload_scan_command('get',$1) AS result",[owner])).rows[0].result.state,"rejected");
      assert.deepEqual((await probe.query("SELECT app_upload_command('usage',$1) AS result",[owner])).rows[0].result,{ files: 1,bytes: 10 });
      assert.equal((await probe.query("SELECT app_append_conversation_event($1,$2,$3,$4,$5,$6,$7) AS outcome",
        ["upgrade-tenant", "upgrade-owner", operationId, "upgrade-session", eventId, event, 7])).rows[0].outcome, "duplicate");
    } finally { if (withSupabase) await probe.query("RESET ROLE"); }
    assert.equal((await probe.query("SELECT source_index FROM app_conversation_events WHERE event_id=$1", [eventId])).rows[0].source_index, "7");
    if (withSupabase) {
      assert.equal((await probe.query(`SELECT has_function_privilege('authenticated',
        'public.app_append_conversation_event(text,text,uuid,text,text,text,bigint)','EXECUTE') AS allowed`)).rows[0].allowed, false);
      assert.equal((await probe.query("SELECT has_schema_privilege('service_role','app_private','USAGE') AS allowed")).rows[0].allowed,false);
      assert.equal((await probe.query(`SELECT polpermissive FROM pg_policy
        WHERE polrelid='storage.objects'::regclass AND polname='app_private_uploads_quarantine'`)).rows[0]?.polpermissive, false);
      assert.equal((await probe.query("SELECT count(*)::int AS count FROM storage.objects WHERE name='existing-private-object'")).rows[0].count, 1);
    }
    const fence = spawn(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/fence-account-writes.ts",
      "--metadata","postgres","--set-permanent"],{ cwd: root,env: { ...upgradeEnv,
        ACCOUNT_AUDIT_TENANT: "upgrade-tenant",ACCOUNT_AUDIT_SUBJECT: "upgrade-owner" },stdio: ["ignore","pipe","pipe"] });
    let fenceOutput = "",fenceErrors = "";
    fence.stdout.on("data",chunk => { fenceOutput += chunk.toString(); });
    fence.stderr.on("data",chunk => { fenceErrors += chunk.toString(); });
    const [fenceCode,fenceSignal] = await once(fence,"exit");
    if (fenceCode !== 0 || fenceSignal) throw new Error(`PostgreSQL account row fence failed: ${fenceErrors.slice(0,300)}`);
    assert.deepEqual(JSON.parse(fenceOutput).status,"fenced");
    assert.equal(JSON.parse(fenceOutput).created,true);
    assert.equal(fenceOutput.includes("upgrade-owner"),false);
    const rowArchive = join(directory,"account-rows.ndjson");
    const exportEnv = { ...upgradeEnv,ACCOUNT_AUDIT_TENANT: "upgrade-tenant",ACCOUNT_AUDIT_SUBJECT: "upgrade-owner" };
    await run(["node_modules/tsx/dist/cli.mjs","scripts/export-account-rows.ts","--metadata","postgres",
      "--output",rowArchive,"--stopped"],0,exportEnv);
    await run(["node_modules/tsx/dist/cli.mjs","scripts/export-account-rows.ts","--verify",rowArchive]);
    const exported = (await readFile(rowArchive,"utf8")).trimEnd().split("\n").map(line => JSON.parse(line));
    assert.equal(exported[0].value.owner.subject,"upgrade-owner");
    assert.ok(exported.some(item => item.type === "row" && item.value.entity === "records" &&
      item.value.rowJson.includes(recordId)));
    assert.ok(exported.some(item => item.type === "row" && item.value.entity === "conversationEvents" &&
      item.value.rowJson.includes(eventId)));
    assert.equal(exported.some(item => item.type === "row" && item.value.rowJson.includes("other-owner")),false);
    const bundleRecord = randomUUID(),bundleSubject = "bundle-owner";
    await probe.query("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,'upgrade-tenant',$2,'Bundle','private bundle fixture')",
      [bundleRecord,bundleSubject]);
    const bundleOperation = randomUUID(),bundleConversation = randomUUID(),bundleEvent = `evt_${"A".repeat(26)}`;
    await probe.query(`INSERT INTO app_conversations(id,tenant,subject,operation_id,request_hash,session_id,status,title,created_at)
      VALUES($1,'upgrade-tenant',$2,$3,$4,'bundle-session','active','Bundle conversation',1)`,
      [bundleConversation,bundleSubject,bundleOperation,"b".repeat(64)]);
    const bundlePayload = JSON.stringify({ schemaVersion: 1,eventId: bundleEvent,at: "2026-09-28T00:00:00.000Z",
      turnId: "bundle-turn",sequence: 0,payload: { kind: "run",state: "completed" } });
    await probe.query(`INSERT INTO app_conversation_events(ordinal,operation_id,event_id,payload)
      OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4)`,["9007199254740993",bundleOperation,bundleEvent,bundlePayload]);
    await probe.query("INSERT INTO app_budget_accounts(tenant,subject) VALUES('upgrade-tenant',$1)",[bundleSubject]);
    await probe.query(`INSERT INTO app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,
      estimate_micros,day,created_at,status) VALUES($1,'upgrade-tenant',$2,$3,'bundle-policy',42,1,1,'reserved')`,
      [bundleOperation,bundleSubject,"c".repeat(64)]);
    await probe.query("INSERT INTO app_budget_attempts(operation_id,attempt_id) VALUES($1,$2)",
      [bundleOperation,"d".repeat(64)]);
    const bundleObjects = await mkdtemp(join(directory,"bundle-objects-"));
    const bundle = join(directory,"account-bundle");
    const bundleEnv = { ...upgradeEnv,ACCOUNT_AUDIT_TENANT: "upgrade-tenant",ACCOUNT_AUDIT_SUBJECT: bundleSubject,
      UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: bundleObjects };
    await run(["node_modules/tsx/dist/cli.mjs","scripts/fence-account-writes.ts","--metadata","postgres","--set-permanent"],0,bundleEnv);
    await run(["node_modules/tsx/dist/cli.mjs","scripts/export-account-bundle.ts","--metadata","postgres",
      "--output",bundle,"--stopped"],0,bundleEnv);
    await run(["node_modules/tsx/dist/cli.mjs","scripts/export-account-bundle.ts","--verify",bundle]);
    assert.ok((await readFile(join(bundle,"rows.ndjson"),"utf8")).includes(bundleRecord));
    assert.equal(JSON.parse(await readFile(join(bundle,"manifest.json"),"utf8")).objects,0);
    assert.equal(JSON.parse(await readFile(join(bundle,"manifest.json"),"utf8")).rows,7);
    await database.createDatabase("app_account_rehearsal_upgrade");
    const rehearsalUrl = upgradeEnv.DATABASE_URL.replace(/\/app_upgrade_test$/, "/app_account_rehearsal_upgrade");
    await run(["scripts/migrate.ts"],0,{ ...upgradeEnv,DATABASE_URL: rehearsalUrl });
    const rehearsalEnv = { ...bundleEnv,ACCOUNT_REHEARSAL_DATABASE_URL: rehearsalUrl };
    await run(["node_modules/tsx/dist/cli.mjs","scripts/rehearse-postgres-account-bundle.ts","--source",bundle],0,rehearsalEnv);
    await run(["node_modules/tsx/dist/cli.mjs","scripts/rehearse-postgres-account-bundle.ts","--source",bundle],1,
      { ...rehearsalEnv,ACCOUNT_REHEARSAL_DATABASE_URL: `${rehearsalUrl}?dbname=app_upgrade_test` });
    const rehearsalProbe = new Client({ connectionString: rehearsalUrl });
    await rehearsalProbe.connect();
    try {
      assert.equal((await rehearsalProbe.query("SELECT count(*)::int AS count FROM app_records")).rows[0].count,0);
      assert.equal((await rehearsalProbe.query("SELECT count(*)::int AS count FROM app_conversation_events")).rows[0].count,0);
      assert.equal((await rehearsalProbe.query("SELECT count(*)::int AS count FROM app_private.account_fences")).rows[0].count,0);
      await rehearsalProbe.query("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,'other','owner','Unrelated','Keep')",
        [randomUUID()]);
      await run(["node_modules/tsx/dist/cli.mjs","scripts/rehearse-postgres-account-bundle.ts","--source",bundle],1,rehearsalEnv);
      assert.equal((await rehearsalProbe.query("SELECT count(*)::int AS count FROM app_records")).rows[0].count,1);
    } finally { await rehearsalProbe.end(); }
    await assert.rejects(() => probe.query("UPDATE app_records SET content='late' WHERE id=$1",[recordId]),/fenced/);
    await assert.rejects(() => probe.query("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,'upgrade-tenant','upgrade-owner','Late','No')",[randomUUID()]),/fenced/);
    await assert.rejects(() => probe.query("UPDATE app_uploads SET state='deleting' WHERE id=$1",[uploadId]),/fenced/);
    await assert.rejects(() => probe.query("INSERT INTO app_conversation_events(operation_id,event_id,payload) VALUES($1,$2,$3)",
      [operationId,`evt_${"2".repeat(26)}`,event]),/fenced/);
    await assert.rejects(() => probe.query("UPDATE app_private.account_fences SET created_at=now()"),/permanent/);
    await assert.rejects(() => probe.query("DELETE FROM app_private.account_fences"),/permanent/);
    await probe.query("UPDATE app_records SET content='other remains writable' WHERE tenant='upgrade-tenant' AND subject='other-owner'");
    assert.equal((await probe.query("SELECT content FROM app_records WHERE tenant='upgrade-tenant' AND subject='other-owner'")).rows[0].content,
      "other remains writable");
    await probe.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await assert.rejects(() => probe.query("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,'upgrade-tenant','other-owner','Late','No')",[randomUUID()]),/read committed/);
    await probe.query("ROLLBACK");
    const fenceConnection = new Client({ connectionString: upgradeEnv.DATABASE_URL });
    const lateWriter = new Client({ connectionString: upgradeEnv.DATABASE_URL });
    await fenceConnection.connect();await lateWriter.connect();
    try {
      await fenceConnection.query("BEGIN");
      await fenceConnection.query("INSERT INTO app_private.account_fences(tenant,subject) VALUES('upgrade-tenant','race-owner')");
      const writerPid = (await lateWriter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const pending = lateWriter.query("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,'upgrade-tenant','race-owner','Late','No')",[randomUUID()])
        .then(() => null,error => error);
      let blocked = false;
      for (let attempt = 0;attempt < 50;attempt++) {
        const waiting = (await probe.query("SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1",[writerPid])).rows[0];
        if (waiting?.wait_event_type === "Lock" && waiting.wait_event === "advisory") { blocked = true;break; }
        await new Promise(resolve => setTimeout(resolve,100));
      }
      assert.equal(blocked,true,"A concurrent row write must wait for the operator's fence transaction");
      await fenceConnection.query("COMMIT");
      const refusal = await pending;
      assert.match(refusal?.message ?? "",/fenced/,"A delayed row write must observe the committed fence");
    } finally {
      await fenceConnection.query("ROLLBACK").catch(() => {});
      await fenceConnection.end();await lateWriter.end();
    }
    await probe.query("ALTER TABLE public.app_records DISABLE TRIGGER app_account_fence_write");
    try {
      const unguardedArchive = join(directory,"unguarded-rows.ndjson");
      await run(["node_modules/tsx/dist/cli.mjs","scripts/fence-account-writes.ts",
        "--metadata","postgres","--set-permanent"],1,exportEnv);
      await run(["node_modules/tsx/dist/cli.mjs","scripts/export-account-rows.ts","--metadata","postgres",
        "--output",unguardedArchive,"--stopped"],1,exportEnv);
      await assert.rejects(() => stat(unguardedArchive),{ code: "ENOENT" });
    } finally { await probe.query("ALTER TABLE public.app_records ENABLE TRIGGER app_account_fence_write"); }
    console.log(`Populated ${withSupabase ? "Supabase" : "PostgreSQL"} schema upgrade passed (${names.length - boundary - 1} later migrations).`);
  } catch (error) { await probe.query("ROLLBACK").catch(() => {}); throw error; }
  finally { await probe.end(); }
}
async function rehearseBackup() {
  const recordId = randomUUID();
  const source = new Client({ connectionString: env.DATABASE_URL });
  await source.connect();
  try {
    await source.query("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,$2,$3,$4,$5)",
      [recordId, "backup-tenant", "backup-owner", "Restored record", "private backup fixture"]);
  } finally { await source.end(); }
  await database.createDatabase("app_backup_restore_test");
  const restoreUrl = env.DATABASE_URL.replace(/\/app_test$/, "/app_backup_restore_test");
  const output = join(directory, "application.dump");
  const result = await backupPostgresApplication(env.DATABASE_URL, output, restoreUrl);
  assert.equal(result.restoreVerified, true);
  assert.ok(result.bytes > 0);
  assert.equal((await stat(output)).mode & 0o077, 0, "Published archive must be private");
  const restored = new Client({ connectionString: restoreUrl });
  await restored.connect();
  try {
    assert.deepEqual((await restored.query("SELECT tenant,subject,title,content,revision FROM app_records WHERE id=$1", [recordId])).rows[0],
      { tenant: "backup-tenant", subject: "backup-owner", title: "Restored record", content: "private backup fixture", revision: 1 });
    assert.equal((await restored.query("SELECT count(*)::int AS count FROM app_migrations")).rows[0].count,
      (await readdir(join(root, "migrations"))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).length);
  } finally { await restored.end(); }
  await assert.rejects(backupPostgresApplication(env.DATABASE_URL, output), /already exists/);
  await assert.rejects(backupPostgresApplication(env.DATABASE_URL, join(directory, "invalid.dump"), env.DATABASE_URL), /must differ/);
  await assert.rejects(backupPostgresWorkflow(env.DATABASE_URL, join(directory, "wrong-world.dump"), undefined, true),
    /not a migrated Eve Workflow database/);
  const archiveOnly = await backupPostgresApplication(env.DATABASE_URL, join(directory, "archive-only.dump"));
  assert.equal(archiveOnly.restoreVerified, false);
  const cliOutput = join(directory, "cli.dump");
  await run(["scripts/backup-postgres.mjs", "--output", cliOutput]);
  assert.equal((await stat(cliOutput)).mode & 0o077, 0);
  await database.createDatabase("app_cli_restore_test");
  const cliRestoreUrl = env.DATABASE_URL.replace(/\/app_test$/, "/app_cli_restore_test");
  await run(["scripts/backup-postgres.mjs", "--output", join(directory, "cli-restored.dump"), "--verify-restore"],
    0, { ...env, BACKUP_VERIFY_DATABASE_URL: cliRestoreUrl });
  const cliRestored = new Client({ connectionString: cliRestoreUrl });
  await cliRestored.connect();
  try {
    assert.equal((await cliRestored.query("SELECT content FROM app_records WHERE id=$1", [recordId])).rows[0].content,
      "private backup fixture");
  } finally { await cliRestored.end(); }
  const runner = process.env.PG_CLIENT_RUNNER;
  const failedOutput = join(directory, "failed.dump");
  process.env.PG_CLIENT_RUNNER = join(directory, "missing-pg-client");
  try { await assert.rejects(backupPostgresApplication(env.DATABASE_URL, failedOutput), /could not start/); }
  finally {
    if (runner === undefined) delete process.env.PG_CLIENT_RUNNER;
    else process.env.PG_CLIENT_RUNNER = runner;
  }
  assert.equal(await stat(failedOutput).then(() => true, () => false), false, "Failed dump must not publish a partial file");
  assert.equal((await readdir(directory)).some(name => name.startsWith(".postgres-backup-")), false,
    "Failed dump must remove its temporary archive");
  await database.createDatabase("workflow_pair_test");
  const workflowUrl = env.DATABASE_URL.replace(/\/app_test$/, "/workflow_pair_test");
  await run(["scripts/migrate-workflow.mjs"], 0,
    { ...env, WORKFLOW_POSTGRES_URL: workflowUrl, WORKFLOW_POSTGRES_JOB_PREFIX: "backup_pair_test" });
  await database.createDatabase("app_pair_restore_test");
  await database.createDatabase("workflow_pair_restore_test");
  const appPairRestoreUrl = env.DATABASE_URL.replace(/\/app_test$/, "/app_pair_restore_test");
  const workflowPairRestoreUrl = env.DATABASE_URL.replace(/\/app_test$/, "/workflow_pair_restore_test");
  const pairOutput = join(directory, "database-set");
  const uploadRoot = join(directory, "private-uploads"), uploadFixture = join(directory, "upload-fixture.json");
  await run(["--import", "tsx", "scripts/testing/restored-upload-contract.ts", "--seed"], 0,
    { ...env, RESTORED_UPLOAD_ROOT: uploadRoot, RESTORED_UPLOAD_FIXTURE: uploadFixture });
  const pairEnv = { ...env, WORKFLOW_POSTGRES_URL: workflowUrl,
    UPLOAD_STORAGE_PROVIDER: "local", UPLOAD_LOCAL_ROOT: uploadRoot,
    BACKUP_VERIFY_APP_DATABASE_URL: appPairRestoreUrl,
    BACKUP_VERIFY_WORKFLOW_DATABASE_URL: workflowPairRestoreUrl };
  await run(["scripts/backup-postgres-databases.mjs", "--create", "--output", pairOutput,
    "--stopped", "--verify-restore", "--uploads-dir", uploadRoot], 0, pairEnv);
  assert.deepEqual(await verifyPostgresDatabaseSet(pairOutput), {
    files: 7, bytes: (await verifyPostgresDatabaseSet(pairOutput)).bytes,
    restoreVerified: true, uploads: "included", uploadFiles: 5,
  });
  const restoredUploads = join(directory, "restored-uploads");
  await run(["scripts/backup-postgres-databases.mjs", "--restore-uploads", pairOutput, "--output", restoredUploads], 0,
    { ...env, DATABASE_URL: "", WORKFLOW_POSTGRES_URL: "" });
  const capturedObjects = await describeUploadSnapshot(restoredUploads);
  assert.deepEqual(await checkSnapshotUploadCatalog(appPairRestoreUrl, capturedObjects), { rows: 509, objects: 5, integrityRejected: 1 });
  await run(["--import", "tsx", "scripts/testing/restored-upload-contract.ts", "--verify"], 0,
    { ...env, DATABASE_URL: appPairRestoreUrl, RESTORED_UPLOAD_ROOT: restoredUploads, RESTORED_UPLOAD_FIXTURE: uploadFixture });
  await assert.rejects(restorePostgresUploadSnapshot(pairOutput, restoredUploads), /EEXIST/);
  // The restoration contract deleted one restored upload. Detect the mismatched
  // catalog instead of calling the unchanged captured bytes a valid fresh set.
  await assert.rejects(checkSnapshotUploadCatalog(appPairRestoreUrl, capturedObjects), /deleted catalog entry still has bytes/);
  await run(["scripts/backup-postgres-databases.mjs", "--verify", pairOutput], 0,
    { ...env, DATABASE_URL: "", WORKFLOW_POSTGRES_URL: "" });
  assert.equal((await stat(pairOutput)).mode & 0o077, 0);
  const appRestored = new Client({ connectionString: appPairRestoreUrl });
  await appRestored.connect();
  try { assert.equal((await appRestored.query("SELECT content FROM app_records WHERE id=$1", [recordId])).rows[0].content,
    "private backup fixture"); }
  finally { await appRestored.end(); }
  const workflowRestored = new Client({ connectionString: workflowPairRestoreUrl });
  await workflowRestored.connect();
  try {
    assert.ok((await workflowRestored.query("SELECT count(*)::int AS count FROM workflow_drizzle.workflow_migrations")).rows[0].count > 0);
    assert.ok((await workflowRestored.query("SELECT count(*)::int AS count FROM graphile_worker.migrations")).rows[0].count > 0);
  } finally { await workflowRestored.end(); }
  await assert.rejects(createPostgresDatabaseSet({ applicationUrl: env.DATABASE_URL,
    workflowUrl, output: pairOutput, stopped: true }), /destination already exists/);
  // A wrong/missing source object cannot publish an apparently complete pair.
  const fixture = JSON.parse(await readFile(uploadFixture, "utf8"));
  const cleanObject = capturedObjects.find(row => row.name.endsWith(`/${fixture.clean}`));
  const cleanPath = join(uploadRoot, cleanObject.name.slice("uploads/".length));
  await writeFile(cleanPath, "altered source bytes");
  const mismatchedPair = join(directory, "mismatched-database-set");
  await assert.rejects(createPostgresDatabaseSet({ applicationUrl: env.DATABASE_URL, workflowUrl, output: mismatchedPair,
    uploadsDir: uploadRoot, stopped: true, env: {} }), /do not match their catalog entry/);
  assert.equal(await stat(mismatchedPair).then(() => true, () => false), false);
  await rm(cleanPath);
  const missingObjectPair = join(directory, "missing-object-set");
  await assert.rejects(createPostgresDatabaseSet({ applicationUrl: env.DATABASE_URL, workflowUrl, output: missingObjectPair,
    uploadsDir: uploadRoot, stopped: true, env: {} }), /missing its object bytes/);
  assert.equal(await stat(missingObjectPair).then(() => true, () => false), false);
  await database.createDatabase("workflow_pair_missing_test");
  const missingWorkflowUrl = env.DATABASE_URL.replace(/\/app_test$/, "/workflow_pair_missing_test");
  const incompletePair = join(directory, "incomplete-database-set");
  await assert.rejects(createPostgresDatabaseSet({ applicationUrl: env.DATABASE_URL,
    workflowUrl: missingWorkflowUrl, output: incompletePair, stopped: true }), /not a migrated Eve Workflow database/);
  assert.equal(await stat(incompletePair).then(() => true, () => false), false,
    "A failed paired backup must not publish a partial directory");
  await appendFile(join(pairOutput, "application.dump"), "tampered");
  await assert.rejects(verifyPostgresDatabaseSet(pairOutput), /hashes or sizes differ/);
  console.log("Private PostgreSQL application/Workflow archives and local upload catalog/object restores passed.");
}
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  stopping = true; child?.kill(signal);
});
try {
  await database.initialise();
  await database.start();
  await database.createDatabase("app_test");
  if (stopping) throw new Error("Interrupted.");
  await run(["scripts/migrate.ts", "--dry-run"]);
  const migrationProbe = new Client({ connectionString: env.DATABASE_URL });
  await migrationProbe.connect();
  try {
    const result = await migrationProbe.query("SELECT to_regclass('app_migrations')::text AS name");
    assert.equal(result.rows[0].name, null, "Migration dry-run must not create the ledger or schema");
  } finally { await migrationProbe.end(); }
  if (withSupabase) {
    const admin = new Client({ connectionString: env.DATABASE_URL });
    await admin.connect();
    try {
      await admin.query(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
        GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
        CREATE SCHEMA storage;
        CREATE TABLE storage.objects (bucket_id text NOT NULL, name text NOT NULL, PRIMARY KEY(bucket_id,name));
        ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
        GRANT USAGE ON SCHEMA storage TO anon, authenticated;
        GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO anon, authenticated;
        CREATE POLICY test_broad_storage ON storage.objects FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
        INSERT INTO storage.objects(bucket_id,name) VALUES ('app-private-uploads','private'),('other-bucket','other');`);
    } finally { await admin.end(); }
  }
  // Exercise the real migration runner twice: the second run must be safe.
  if (!withSupabase && !backupOnly) {
    await database.createDatabase("cloud_migration_workflows");
    await run(["--import", "tsx", "scripts/test-cloud-migrations.ts"], 0, {
      ...env, WORKFLOW_POSTGRES_URL: env.DATABASE_URL.replace(/\/app_test$/, "/cloud_migration_workflows"),
    });
  }
  await run(["scripts/migrate.ts"]);
  await run(["scripts/migrate.ts"]);
  await run(["scripts/migrate.ts", "--dry-run"]);
  if (!backupOnly) await rehearseMigrationLedgerSearchPath();
  const driftProbe = new Client({ connectionString: env.DATABASE_URL });
  await driftProbe.connect();
  try {
    await driftProbe.query("INSERT INTO app_migrations(name) VALUES($1)", ["99999999_unknown.sql"]);
    await run(["scripts/migrate.ts", "--dry-run"], 1);
    await run(["scripts/migrate.ts"], 1);
    await driftProbe.query("DELETE FROM app_migrations WHERE name=$1", ["99999999_unknown.sql"]);
  } finally { await driftProbe.end(); }
  await rehearseUpgrade();
  if (backupOnly) await rehearseBackup();
  if (withSupabase) {
    const executable = await installPostgrest(join(directory, "postgrest"));
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const restPort = reservation.address().port;
    await new Promise(resolve => reservation.close(resolve));
    const jwtSecret = randomBytes(32).toString("hex");
    postgrest = spawn(executable, [], { env: { ...process.env,
      PGRST_DB_URI: env.DATABASE_URL, PGRST_DB_SCHEMAS: "public", PGRST_DB_ANON_ROLE: "anon",
      PGRST_JWT_SECRET: jwtSecret, PGRST_SERVER_HOST: "127.0.0.1", PGRST_SERVER_PORT: String(restPort),
      ...(process.platform === "darwin" ? { DYLD_LIBRARY_PATH: join(root, `node_modules/@embedded-postgres/darwin-${process.arch}/native/lib`) } : {}),
    }, stdio: ["ignore", "ignore", "pipe"] });
    let restError;
    postgrest.on("error", error => { restError = error; });
    // Drain diagnostics but never print connection strings from a subprocess.
    postgrest.stderr.on("data", chunk => { restDiagnostics = (restDiagnostics + chunk.toString()).slice(-4000).replaceAll(env.DATABASE_URL, "[database]").replaceAll(password, "[redacted]").replaceAll(jwtSecret, "[redacted]"); });
    const deadline = Date.now() + 20_000;
    while (true) {
      if (restError || postgrest.exitCode !== null || postgrest.signalCode !== null) throw new Error(`PostgREST failed to start (${postgrest.signalCode ?? postgrest.exitCode ?? "spawn error"}).`);
      try { const response = await fetch(`http://127.0.0.1:${restPort}/`, { signal: AbortSignal.timeout(1000) }); if (response.ok) break; } catch {}
      if (Date.now() > deadline) throw new Error("PostgREST readiness timed out.");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Supabase's gateway maps /rest/v1/* onto PostgREST. This proxy only performs
    // that path mapping; all queries, JWT checks, SQL, RLS and grants run for real.
    proxy = createHttpServer(async (request, response) => {
      if (!request.url?.startsWith("/rest/v1/")) { response.writeHead(404); response.end(); return; }
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === "string" && !["host", "connection", "content-length", "transfer-encoding"].includes(key)) headers.set(key, value);
        const upstream = await fetch(`http://127.0.0.1:${restPort}${request.url.slice(8)}`, { method: request.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined, signal: AbortSignal.timeout(10_000) });
        response.writeHead(upstream.status, Object.fromEntries(upstream.headers)); response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { response.writeHead(502); response.end(); }
    });
    proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
    const token = role => new SignJWT({ role }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(new TextEncoder().encode(jwtSecret));
    env.DATA_PROVIDER = "supabase";
    env.SUPABASE_URL = `http://127.0.0.1:${proxy.address().port}`;
    env.SUPABASE_SECRET_KEY = await token("service_role");
    env.TEST_SUPABASE_ANON_TOKEN = await token("anon");
    env.TEST_SUPABASE_USER_TOKEN = await token("authenticated");
  }
  if (!backupOnly) await run(["node_modules/vitest/vitest.mjs", "run", "--config", "vitest.integration.config.ts"]);
  console.log(backupOnly ? "Disposable PostgreSQL: backup and restore contract passed."
    : withSupabase ? "Supabase adapter: real PostgreSQL/PostgREST contract and direct-access checks passed."
    : "Disposable PostgreSQL: migrations and repository contract passed.");
} catch (error) {
  validationFailed = true;
  console.error(error instanceof Error ? error.message : "Database validation failed.");
  if (restDiagnostics) console.error(restDiagnostics);
  process.exitCode = 1;
} finally {
  if (proxy) await new Promise(resolve => proxy.close(resolve));
  if (postgrest && postgrest.exitCode === null && postgrest.signalCode === null) {
    const exited = once(postgrest, "exit");
    postgrest.kill("SIGTERM");
    const timeout = setTimeout(() => postgrest.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timeout);
  }
  await database.stop().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
// embedded-postgres installs async exit hooks; make the final outcome explicit
// after all teardown work rather than relying on a mutable process.exitCode.
process.exit(validationFailed ? 1 : 0);
