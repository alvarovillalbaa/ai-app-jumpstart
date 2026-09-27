import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn,type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp,mkdtemp,readFile,readdir,rm,symlink,writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";
import { createWorld } from "@workflow/world-local";
import { getEventDataRefFields } from "@workflow/world";
import { Client as Postgres } from "pg";
import { workflowPostgresFixture } from "./helpers/workflow-postgres-fixture.mjs";
import { testCommand } from "./helpers/test-command.mjs";

const root = fileURLToPath(new URL("../",import.meta.url));
const source = join(root,"tests/fixtures/eve-retention");
type Run = { runId: string;workflowName: string;status: string;attributes: Record<string,string>;expiredAt?: unknown;input?: unknown;output?: unknown;error?: unknown };

async function rehearse(provider: "default" | "postgres",retention: "default" | "0") {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-retention-")),fixture = join(directory,"app");
  const token = randomBytes(32).toString("hex"),message = `private-retention-${randomBytes(12).toString("hex")}`;
  const secrets = [token,message];
  let child: ChildProcess | undefined,database: Awaited<ReturnType<typeof workflowPostgresFixture>> | undefined;
  let pg: Postgres | undefined,world: ReturnType<typeof createWorld> | undefined;
  let diagnostics = "";
  async function stop() {
    if (child?.exitCode === null && child.signalCode === null) {
      const ended = once(child,"exit");child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"),5000);
      try { await ended; } finally { clearTimeout(timer); }
    }
  }
  const interrupt = () => { child?.kill("SIGTERM"); };
  process.on("SIGINT",interrupt);process.on("SIGTERM",interrupt);
  try {
    const listener = createServer();listener.listen(0,"127.0.0.1");await once(listener,"listening");
    const address = listener.address();assert.ok(address && typeof address !== "string");
    const port = address.port;await new Promise<void>(resolve => listener.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`,dataDir = join(fixture,".eve/.workflow-data");
    const receipts = join(directory,"model.txt"),gate = join(directory,"gate");
    const env: NodeJS.ProcessEnv = { ...process.env,NODE_ENV: "production",NITRO_PRESET: "node-server",EVE_DEV: "",EVE_TELEMETRY_DISABLED: "1",
      HOST: "127.0.0.1",NITRO_HOST: "127.0.0.1",PORT: String(port),NITRO_PORT: String(port),
      AI_CHAT_ENABLED: "false",EVE_WORKFLOW_PROVIDER: provider,EVE_WORKFLOW_RETENTION: retention,WORKFLOW_EXPECTED_RETENTION: retention,
      TEST_RETENTION_TOKEN: token,TEST_RETENTION_RECEIPTS: receipts,TEST_RETENTION_GATE: gate,
      WORKFLOW_TARGET_WORLD: "local",WORKFLOW_LOCAL_DATA_DIR: dataDir,WORKFLOW_LOCAL_BASE_URL: origin,
    };
    for (const key of ["VERCEL","VERCEL_ENV","VERCEL_TARGET_ENV","VERCEL_OIDC_TOKEN","AI_GATEWAY_API_KEY","OPENAI_API_KEY","ANTHROPIC_API_KEY","WORKFLOW_POSTGRES_URL"]) delete env[key];
    if (provider === "postgres") {
      database = await workflowPostgresFixture();secrets.push(database.url);
      env.WORKFLOW_POSTGRES_URL = database.url;env.WORKFLOW_POSTGRES_JOB_PREFIX = "retention_fixture";
      delete env.WORKFLOW_TARGET_WORLD;
      await testCommand(process.execPath,[join(root,"scripts/migrate-workflow.mjs")],{ cwd: directory,env },secrets);
      pg = new Postgres({ connectionString: database.url,connectionTimeoutMillis: 5000 });await pg.connect();
    } else world = createWorld({ dataDir,baseUrl: origin,recoverActiveRuns: false });
    await cp(join(source,"agent"),join(fixture,"agent"),{ recursive: true });
    const pkg = JSON.parse(await readFile(join(source,"package.json"),"utf8"));
    await writeFile(join(fixture,"package.json"),JSON.stringify({ ...pkg,name: `retention-${randomBytes(8).toString("hex")}` }));
    await symlink(join(root,"node_modules"),join(fixture,"node_modules"),"dir");
    async function relocate(relative: string) {
      for (const item of await readdir(join(fixture,relative),{ withFileTypes: true })) {
        const path = join(relative,item.name);
        if (item.isDirectory()) await relocate(path);
        else if (item.name.endsWith(".ts")) {
          const text = await readFile(join(fixture,path),"utf8");
          await writeFile(join(fixture,path),text.replace(/from "(\.\.?\/[^\"]+)"/g,(_match,specifier: string) => `from ${JSON.stringify(resolve(dirname(join(source,path)),specifier))}`));
        }
      }
    }
    await relocate("agent");
    await testCommand(join(root,"node_modules/.bin/eve"),["build"],{ cwd: fixture,env },secrets);
    child = spawn(process.execPath,[join(fixture,".output/server/index.mjs")],{ cwd: fixture,env,stdio: ["ignore","pipe","pipe"] });
    const capture = (chunk: Buffer) => { diagnostics = (diagnostics+chunk).slice(-10_000); };
    child.stdout?.on("data",capture);child.stderr?.on("data",capture);
    let spawnFailed = false;child.on("error",() => { spawnFailed = true; });
    async function eventually(check: () => Promise<boolean>,label: string) {
      const deadline = Date.now()+45_000;
      while (Date.now()<deadline) {
        if (spawnFailed || child?.exitCode !== null || child?.signalCode !== null) throw new Error("Retention fixture stopped.");
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve,100));
      }
      throw new Error(label);
    }
    async function runs(): Promise<Run[]> {
      if (pg) return (await pg.query(`SELECT id AS "runId",name AS "workflowName",status,attributes,expired_at AS "expiredAt",
        input_cbor AS input,output_cbor AS output,error_cbor AS error FROM workflow.workflow_runs ORDER BY created_at`)).rows;
      const result = await world!.runs.list({ resolveData: "all",pagination: { limit: 100 } });
      assert.equal(result.hasMore,false,"Fixture inventory exceeded one bounded page.");return result.data;
    }
    await eventually(async () => (await fetch(`${origin}/eve/v1/health`,{ signal: AbortSignal.timeout(1000) }).catch(() => null))?.ok ?? false,"Retention fixture readiness timed out.");
    assert.equal((await fetch(`${origin}/eve/v1/info`)).status,401);
    const client = new Client({ host: origin,auth: { bearer: token },redirect: "error" });
    const { session,response } = await client.sessions.create({ message });
    await eventually(async () => (await readFile(receipts,"utf8").catch(() => "")).includes("called"),"Model did not receive private input.");
    const before = await runs(),active = before.find(row => row.runId===session.state.sessionId);
    assert.ok(active,`Native run inventory did not contain session ${session.state.sessionId}; found ${before.map(row => row.runId).join(",")}.`);assert.ok(active.input,"Live run input must be retained before the terminal transition.");
    assert.ok(!active.expiredAt);assert.equal(active.attributes["$retention"],retention === "0" ? "0" : undefined);
    await writeFile(gate,"ready");
    if (retention === "default") {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([response.result(),new Promise<never>((_resolve,reject) => {
          timer = setTimeout(() => reject(new Error("Default-retention response timed out.")),20_000);
        })]);
        assert.ok(JSON.stringify(result).includes(`Retained fixture response: ${message}`),"The default-retention model response must be readable.");
      } finally { clearTimeout(timer); }
    }
    await eventually(async () => (await runs()).some(row => row.runId!==session.state.sessionId && ["completed","failed"].includes(row.status)),"Turn did not finish.");
    // A terminal turn may already have retired its parent under zero retention.
    // Reset an active parent without trying to read an expired turn result.
    const current = (await runs()).find(row => row.runId===session.state.sessionId)!;
    if (["pending","running"].includes(current.status)) await session.reset({ reason: "Retention fixture complete" });
    await eventually(async () => {
      const rows = await runs(),parent = rows.find(row => row.runId===session.state.sessionId);
      return !!parent && ["completed","failed","cancelled"].includes(parent.status)
        && (retention !== "0" || rows.filter(row => row.attributes["$retention"] === "0").every(row => !!row.expiredAt));
    },"Terminal run data was not purged.");
    const after = await runs(),parent = after.find(row => row.runId===session.state.sessionId)!;
    if (retention === "default") {
      assert.ok(!parent.expiredAt);assert.ok(parent.input);
      const events = [];for await (const event of client.sessions.attach(session.state.sessionId,{ streamIndex: 0 }).stream({ follow: false,signal: AbortSignal.timeout(10_000),streamReconnectPolicy: { reconnect: false } })) events.push(event);
      assert.ok(JSON.stringify(events).includes(message),"Default retention must preserve the private transcript after terminal reset.");
    } else {
      const scoped = after.filter(row => row.attributes["$retention"] === "0");
      assert.ok(scoped.some(row => row.runId===session.state.sessionId),"The session run must be purged.");
      assert.ok(scoped.some(row => row.workflowName.endsWith("turnWorkflow")),"The actual turn run must be purged.");
      const timer = after.find(row => row.workflowName.endsWith("sessionTimeoutWorkflow"));
      assert.ok(timer && !timer.expiredAt && timer.attributes["$retention"] === undefined && timer.input,
        "Auxiliary timeout runs retain the native default; this is not complete runtime erasure.");
      for (const row of scoped) {
        assert.ok(row.expiredAt);assert.ok(row.input == null && row.output == null && row.error == null,"Expired runs retained a user payload.");
      }
      if (pg) {
        const ids = scoped.map(row => row.runId);
        for (const [table,payload] of [
          ["workflow_runs","input IS NOT NULL OR input_cbor IS NOT NULL OR output IS NOT NULL OR output_cbor IS NOT NULL OR error IS NOT NULL OR error_cbor IS NOT NULL"],
          ["workflow_steps","input IS NOT NULL OR input_cbor IS NOT NULL OR output IS NOT NULL OR output_cbor IS NOT NULL OR error IS NOT NULL OR error_cbor IS NOT NULL"],
          ["workflow_events","payload IS NOT NULL OR payload_cbor IS NOT NULL"],
          ["workflow_hooks","metadata IS NOT NULL OR metadata_cbor IS NOT NULL OR resume_context IS NOT NULL"],
          ["workflow_stream_chunks","octet_length(data)>0"],
        ]) {
          const key = table === "workflow_runs" ? "id" : "run_id";
          const result: { rows: { count: number }[] } = await pg.query(`SELECT count(*)::integer AS count FROM workflow.${table} WHERE ${key}=ANY($1::text[]) AND (${payload})`,[ids]);
          assert.equal(result.rows[0].count,0,`${table} retained user payloads.`);
        }
      } else {
        const ids = new Set(scoped.map(row => row.runId));
        for (const kind of ["steps","events","hooks"]) {
          for (const name of await readdir(join(dataDir,kind)).catch(error => {
            if (error.code === "ENOENT") return [];throw error;
          })) {
            if (!name.endsWith(".json")) continue;
            const row = JSON.parse(await readFile(join(dataDir,kind,name),"utf8"));
            if (!ids.has(row.runId)) continue;
            const fields = kind === "steps" ? ["input","output","error"] : kind === "hooks" ? ["metadata","resumeContext"] : getEventDataRefFields(row.eventType);
            const payload = kind === "events" ? row.eventData : row;
            assert.ok(fields.every(field => payload?.[field] == null),`Local ${kind} retained a user payload.`);
          }
        }
        for (const row of scoped) for (const stream of await world!.streams.list(row.runId)) {
          const chunks = await world!.streams.getChunks!(row.runId,stream,{ limit: 1000 });
          assert.ok(chunks.done,"Purged local stream must terminate.");
          assert.equal(chunks.hasMore,false);assert.ok(chunks.data.every(chunk => chunk.data.length===0),"Purged local stream retained bytes.");
        }
      }
    }
    console.log(`${provider} Workflow retention ${retention}: live input, terminal payload policy and native metadata checked.`);
  } catch (error) {
    let text = error instanceof Error ? error.message : "Retention verification failed.";
    for (const secret of secrets) { text = text.replaceAll(secret,"[redacted]");diagnostics = diagnostics.replaceAll(secret,"[redacted]"); }
    console.error(text);console.error(diagnostics);throw new Error(`Retention verification failed for ${provider}/${retention}.`);
  } finally {
    process.off("SIGINT",interrupt);process.off("SIGTERM",interrupt);
    await stop();await world?.close?.();await pg?.end();await database?.stop();await rm(directory,{ recursive: true,force: true });
  }
}

let failed = false;
try {
  for (const provider of ["default","postgres"] as const) for (const retention of ["default","0"] as const) await rehearse(provider,retention);
} catch { failed = true; }
process.exit(failed ? 1 : 0);
