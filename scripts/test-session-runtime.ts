import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "eve/client";
import { sqliteAccessStore } from "../lib/agent-access/sqlite";
import { ConversationBroker, creationTransport } from "../lib/agent-access/broker";
import { BudgetedCreation } from "../lib/budgets/creation";
import { sqliteBudgetStore } from "../lib/budgets/sqlite";
import { SqliteRepository } from "../lib/data/sqlite";
import { workflowPostgresFixture } from "./helpers/workflow-postgres-fixture.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const postgresWorkflows = process.argv.includes("--postgres-workflows");
let workflowDatabase: Awaited<ReturnType<typeof workflowPostgresFixture>> | undefined;
const sourceFixture = join(root, "tests/fixtures/eve-access");
const directory = await mkdtemp(join(tmpdir(), "jumpstart-session-runtime-"));
let fixture = join(directory,"app");
const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
const address = socket.address(); if (!address || typeof address === "string") throw new Error("No test port.");
const port = address.port; await new Promise<void>(resolve => socket.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`, aliceToken = randomBytes(32).toString("hex"), bobToken = randomBytes(32).toString("hex");
const signing = { audience: "isolated-session-runtime", activeKey: "fixture", keys: { fixture: randomBytes(32).toString("hex") } };
const database = join(directory, "app.sqlite"), receipts = join(directory, "model.txt"), failures = join(directory, "failures.txt"), gate = join(directory, "gate"), modelGate = join(directory, "model-gate");
const budgetSettings = { policy: { id: "fixture", dailyMicros: 60, maxActive: 2, maxPerMinute: 20 }, estimateMicros: 20, maxModelCalls: 1, modelIds: ["model","eve-mock/model"],
  costBasis: { sourceUrl: "https://example.test/fixture-prices", reviewedAt: "2026-09-24", maxOtherMicros: 0,
    models: ["model","eve-mock/model"].map(id => ({ id, maxInputTokens: 1, maxOutputTokens: 1, inputMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 })) } };
const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", EVE_DEV: "", EVE_TELEMETRY_DISABLED: "1", NITRO_PRESET: "node-server",
  HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", PORT: String(port), NITRO_PORT: String(port),
  APP_ORIGIN: origin,
  WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: join(fixture,".eve/.workflow-data"), WORKFLOW_LOCAL_BASE_URL: origin,
  DATA_PROVIDER: "sqlite", SQLITE_PATH: database, TEST_MODEL_RECEIPTS: receipts, TEST_FAILURE_RECEIPTS: failures, TEST_RECEIPT_GATE: gate, TEST_MODEL_GATE: modelGate,
  AI_BUDGET_POLICY_JSON: JSON.stringify(budgetSettings),
  EVE_WORKFLOW_PROVIDER: "default",
  TEST_SIGNING_KEY: signing.keys.fixture, TEST_ALICE_TOKEN: aliceToken, TEST_BOB_TOKEN: bobToken,
};
for (const name of ["VERCEL", "VERCEL_ENV", "VERCEL_TARGET_ENV", "VERCEL_OIDC_TOKEN", "AI_GATEWAY_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) delete env[name];
let child: ChildProcess | undefined, diagnostics = "", interrupted = false, validationFailed = false;
const secrets = [aliceToken, bobToken, signing.keys.fixture];
function start(command: string, args: string[]) {
  const process = spawn(command, args, { cwd: fixture, env, stdio: ["ignore", "pipe", "pipe"] });
  const capture = (chunk: Buffer) => { diagnostics = (diagnostics + chunk.toString()).slice(-12000); };
  process.stdout?.on("data", capture); process.stderr?.on("data", capture);
  return process;
}
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => { interrupted = true; child?.kill(signal); });
async function eventually(check: () => Promise<boolean>, message: string, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (interrupted || child?.exitCode !== null || child?.signalCode !== null) throw new Error("Fixture runtime stopped.");
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
async function lines(path: string) { return (await readFile(path, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length; }
async function workflowRecovery(args: string[]) {
  const command = spawn(process.execPath,[join(root,"scripts/recover-workflow.mjs"),...args],{ cwd: directory, env, stdio: ["ignore","pipe","pipe"] });
  let output = "", errors = "";
  command.stdout?.on("data", chunk => { output += chunk.toString(); });
  command.stderr?.on("data", chunk => { errors += chunk.toString(); });
  const [code] = await once(command,"exit");
  assert.equal(code,0,`Workflow recovery command failed: ${errors}`);
  return JSON.parse(output);
}
async function localBackup(args: string[]) {
  const command = spawn(process.execPath,[join(root,"scripts/backup-local.mjs"),...args],{ cwd: root, env, stdio: ["ignore","pipe","pipe"] });
  let output = "", errors = "";
  command.stdout?.on("data", chunk => { output += chunk.toString(); });
  command.stderr?.on("data", chunk => { errors += chunk.toString(); });
  const [code] = await once(command,"exit");
  assert.equal(code,0,`Local snapshot command failed: ${errors}`);
  return output;
}
let store = sqliteAccessStore(database), storesOpen = true;
const alice = { tenant: "fixture", subject: "alice" };
let budgets = sqliteBudgetStore(database);
try {
  if (postgresWorkflows) {
    workflowDatabase = await workflowPostgresFixture();
    secrets.push(workflowDatabase.url);
    env.EVE_WORKFLOW_PROVIDER = "postgres";
    env.WORKFLOW_POSTGRES_URL = workflowDatabase.url;
    env.WORKFLOW_POSTGRES_JOB_PREFIX = "isolated_fixture";
    env.TEST_CAROL_TOKEN = randomBytes(32).toString("hex"); secrets.push(env.TEST_CAROL_TOKEN);
    delete env.WORKFLOW_TARGET_WORLD;
    // Bootstrap both the storage and worker schemas twice before consumers start.
    for (let run = 0; run < 2; run++) {
      const migration = spawn(process.execPath, [join(root,"scripts/migrate-workflow.mjs")], { cwd: directory, env, stdio: ["ignore","ignore","ignore"] });
      const [code] = await once(migration,"exit");
      if (code !== 0) throw new Error("Workflow database bootstrap failed.");
    }
  }
  await cp(join(sourceFixture,"agent"),join(fixture,"agent"),{ recursive: true });
  const packageJson = JSON.parse(await readFile(join(sourceFixture,"package.json"),"utf8"));
  await writeFile(join(fixture,"package.json"),JSON.stringify({ ...packageJson, name: `jumpstart-session-${randomBytes(8).toString("hex")}` }));
  await symlink(join(root,"node_modules"),join(fixture,"node_modules"),"dir");
  // Each run gets a distinct app/queue namespace and build directory. Keep
  // imports of production code canonical when relocating the fixture sources.
  async function relocate(relative: string) {
    for (const entry of await readdir(join(fixture,relative),{ withFileTypes: true })) {
      const child = join(relative,entry.name);
      if (entry.isDirectory()) await relocate(child);
      else if (entry.name.endsWith(".ts")) {
        const source = await readFile(join(fixture,child),"utf8");
        await writeFile(join(fixture,child),source.replace(/from "(\.\.?\/[^\"]+)"/g,(_match,specifier: string) => `from ${JSON.stringify(resolve(dirname(join(sourceFixture,child)),specifier))}`));
      }
    }
  }
  await relocate("agent");
  await writeFile(gate, "ready");
  child = start(join(root, "node_modules/.bin/eve"), ["build"]);
  const timer = setTimeout(() => child?.kill("SIGTERM"), 180000);
  const [code] = await once(child, "exit"); clearTimeout(timer);
  if (code !== 0 || interrupted) throw new Error("Eve ownership fixture compilation failed.");
  child = start(process.execPath, [join(fixture, ".output/server/index.mjs")]);
  await eventually(async () => (await fetch(`${origin}/eve/v1/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null))?.ok ?? false, "Runtime readiness timed out.");
  const realDispatch = creationTransport(origin, signing); let dispatches = 0;
  const broker = new ConversationBroker(store, async (body, owner) => {
    dispatches++; await realDispatch(body, owner);
    throw new Error("Fixture drops the accepted creation response");
  });
  const creation = new BudgetedCreation(broker,budgets,budgetSettings.policy,() => budgetSettings.estimateMicros);
  const input = { message: "One owned turn", operationId: randomUUID() };
  await creation.create(alice, input);
  await eventually(async () => (await broker.read(alice, input.operationId)).status === "active", "Runtime receipt failed to repair the lost response.");
  const recovered = await creation.create(alice, input);
  assert.equal(recovered.status, "active"); assert.ok(recovered.sessionId); assert.equal(dispatches, 1);
  const client = new Client({ host: origin, auth: { bearer: aliceToken }, redirect: "error" });
  let session = client.sessions.attach(recovered.sessionId);
  await eventually(async () => {
    const events = []; for await (const event of session.stream({ follow: false })) events.push(event.type);
    return events.includes("session.waiting");
  }, "The initial owned turn did not settle.");
  assert.equal(await lines(receipts), 1);
  if (!postgresWorkflows) {
    const records = new SqliteRepository(database);
    const record = await records.create(alice,{ title: "Recovered private record",content: "Snapshot must retain application data." });
    await records.close();
    await eventually(async () => {
      const usage = await budgets.snapshot({ ...alice, now: Date.now() });
      return usage.chargedMicros === 20 && usage.active === 0;
    }, "Initial local turn did not settle before the snapshot.");
    const exited = once(child,"exit"); child.kill("SIGTERM");
    const stopTimer = setTimeout(() => child?.kill("SIGKILL"),5_000);
    try { await exited; } finally { clearTimeout(stopTimer); }
    await store.close(); await budgets.close(); storesOpen = false;
    const snapshot = join(directory,"snapshot"),restoredRoot = join(directory,"restored");
    const builtFixture = fixture;
    const workflowDir = join(builtFixture,".eve/.workflow-data");
    assert.match(await localBackup(["--create","--app-db",database,"--workflow-dir",workflowDir,
      "--no-uploads","--output",snapshot,"--stopped"]),/Verified local snapshot:/);
    assert.match(await localBackup(["--verify",snapshot]),/Local snapshot verified:/);
    assert.match(await localBackup(["--restore",snapshot,"--output",restoredRoot]),/Local snapshot restored to new directory:/);
    env.SQLITE_PATH = join(restoredRoot,"app.sqlite");
    fixture = join(directory,"restored-app");
    await mkdir(join(fixture,".eve"),{ recursive: true });
    await cp(join(builtFixture,".output"),join(fixture,".output"),{ recursive: true });
    await cp(join(builtFixture,"package.json"),join(fixture,"package.json"));
    await symlink(join(root,"node_modules"),join(fixture,"node_modules"),"dir");
    await cp(join(restoredRoot,"workflow"),join(fixture,".eve/.workflow-data"),{ recursive: true });
    env.WORKFLOW_LOCAL_DATA_DIR = join(fixture,".eve/.workflow-data");
    const restoredRecords = new SqliteRepository(env.SQLITE_PATH);
    assert.deepEqual(await restoredRecords.get(alice,record.id),record);
    assert.equal(await restoredRecords.get({ ...alice,subject: "bob" },record.id),null);
    await restoredRecords.close();
    store = sqliteAccessStore(env.SQLITE_PATH); budgets = sqliteBudgetStore(env.SQLITE_PATH); storesOpen = true;
    assert.equal((await store.getOperation(alice,input.operationId))?.sessionId,recovered.sessionId);
    assert.equal(await store.getOperation({ ...alice, subject: "bob" },input.operationId),null);
    assert.equal((await budgets.snapshot({ ...alice, now: Date.now() })).chargedMicros,20);
    child = start(process.execPath,[join(fixture,".output/server/index.mjs")]);
    await eventually(async () => (await fetch(`${origin}/eve/v1/health`,{ signal: AbortSignal.timeout(1000) }).catch(() => null))?.ok ?? false,"Restored local runtime did not start.");
    session = new Client({ host: origin, auth: { bearer: aliceToken }, redirect: "error" }).sessions.attach(recovered.sessionId);
    const replay = []; for await (const event of session.stream({ follow: false })) replay.push(event.type);
    assert.ok(replay.includes("message.completed"),"Restored Eve session did not replay its completed turn.");
    assert.equal(await lines(receipts),1,"Restoring a completed turn must not call the model again.");
    assert.equal((await fetch(`${origin}/eve/v1/session/${recovered.sessionId}/stream`,{ headers: { authorization: `Bearer ${bobToken}` } })).status,401);
    console.log("Default Workflow: stopped local snapshot restored an owned Eve session, replay and isolation.");
  }
  const followup = await (await session.send("Continue the owned conversation")).result();
  assert.ok(followup.events.some(event => event.type === "message.completed"));
  assert.equal(await lines(receipts), 2);
  assert.equal((await budgets.snapshot({ ...alice, now: Date.now() })).chargedMicros,40);
  await session.compact();
  await eventually(async () => (await budgets.snapshot({ ...alice, now: Date.now() })).chargedMicros === 60, "Manual compaction did not settle its independent budget.");
  assert.equal(await lines(receipts),3);
  const denied = await (await session.send("This follow-up exceeds the daily budget")).result();
  assert.ok(denied.events.some(event => event.type === "turn.failed"));
  assert.equal(await lines(receipts),3);
  const bobHeaders = { authorization: `Bearer ${bobToken}` };
  for (const suffix of ["", "/cancel", "/clear", "/compact", "/reset"]) {
    assert.equal((await fetch(`${origin}/eve/v1/session/${recovered.sessionId}${suffix}`, { method: "POST", headers: { ...bobHeaders, "content-type": "application/json" }, body: JSON.stringify({ inputResponses: [{ requestId: "forged", optionId: "approve" }] }) })).status, 401);
  }
  assert.equal((await fetch(`${origin}/eve/v1/session/${recovered.sessionId}/stream`, { headers: bobHeaders })).status, 401);
  assert.equal((await fetch(`${origin}/eve/v1/session`, { method: "POST", headers: { authorization: `Bearer ${aliceToken}`, "content-type": "application/json" }, body: JSON.stringify({ message: "Unsigned" }) })).status, 401);
  // Hold the receipt hook, revoke after HTTP acceptance, then release the hook.
  // The real runtime must fail the turn without reaching the mock model.
  await rm(gate);
  const bob = { ...alice, subject: "bob" }, failuresBefore = await lines(failures);
  let guardedCandidate: string | undefined;
  const guarded = await new BudgetedCreation(new ConversationBroker(store, async (body, owner) => { guardedCandidate = await realDispatch(body, owner); return guardedCandidate; }),budgets,budgetSettings.policy,() => 20).create(bob, { message: "Must never reach the model", operationId: randomUUID() });
  assert.equal(guarded.status, "starting"); assert.equal(guarded.sessionId, null);
  await store.revoke(bob, guarded.conversationId); await writeFile(gate, "ready");
  await eventually(async () => await lines(failures) > failuresBefore, "Revoked runtime binding did not fail its turn.");
  assert.equal(await lines(receipts), 3);
  assert.equal((await fetch(`${origin}/eve/v1/session/${guardedCandidate}/stream`, { headers: { authorization: `Bearer ${bobToken}` } })).status, 401);
  const loopBroker = new ConversationBroker(store,realDispatch), loopInput = { message: "loop-budget-test", operationId: randomUUID() };
  const failedBeforeLoop = await lines(failures);
  await new BudgetedCreation(loopBroker,budgets,budgetSettings.policy,() => 20).create(bob,loopInput);
  await eventually(async () => await lines(failures)>failedBeforeLoop, "Model-call cap did not stop the fixture tool loop.");
  const loop = await loopBroker.read(bob,loopInput.operationId); assert.ok(loop.sessionId);
  await eventually(async () => (await store.listProjections(bob,loopInput.operationId,{})).items.some(entry => entry.payload.kind === "run" && entry.payload.state === "failed"),"Failed turn boundary was not projected.");
  const loopProjections = (await store.listProjections(bob,loopInput.operationId,{})).items;
  assert.ok(loopProjections.some(entry => entry.payload.kind === "tool" && entry.payload.phase === "requested"),"Tool request projection missing.");
  assert.ok(loopProjections.some(entry => entry.payload.kind === "tool" && entry.payload.phase === "result"),"Tool result projection missing.");
  assert.equal((await store.listProjections(alice,loopInput.operationId,{})).items.length,0);
  assert.equal(await lines(receipts),4);
  assert.equal(await budgets.attemptCount({ ...bob, operationId: loopInput.operationId }),1);
  // Eve may treat a stale input response as a fresh user message. Consume Bob's
  // remaining quota through an explicit ordinary turn before testing that such
  // a response cannot grant any additional budget after runtime replacement.
  const finalBobInput = { message: "Use the remaining admitted quota", operationId: randomUUID() };
  await new BudgetedCreation(loopBroker,budgets,budgetSettings.policy,() => 20).create(bob,finalBobInput);
  await eventually(async () => (await budgets.snapshot({ ...bob, now: Date.now() })).chargedMicros === 40,"Final admitted turn did not settle.");
  assert.equal(await lines(receipts),5);
  if (postgresWorkflows) {
    const owner = { tenant: "fixture", subject: "carol" };
    const broker = new ConversationBroker(store,realDispatch);
    const input = { message: "Persist across a runtime replacement", operationId: randomUUID() };
    await new BudgetedCreation(broker,budgets,budgetSettings.policy,() => 20).create(owner,input);
    await eventually(async () => (await broker.read(owner,input.operationId)).status === "active", "PostgreSQL session never activated.");
    const receipt = await broker.read(owner,input.operationId); assert.ok(receipt.sessionId);
    await eventually(async () => (await budgets.snapshot({ ...owner, now: Date.now() })).chargedMicros === 20, "PostgreSQL session did not settle.");
    // Budget settlement precedes Graphile's lock release. Wait for the
    // completed job to leave the worker before simulating a clean restart.
    await eventually(async () => (await workflowRecovery(["list"])).lockedJobs.length === 0, "Completed PostgreSQL job remained locked.");
    const beforeRestart = await lines(receipts);
    const exited = once(child,"exit"); child.kill("SIGKILL"); await exited;
    // An empty local world must not erase or replay a settled PostgreSQL run.
    await rm(join(directory,"workflow"),{ recursive: true, force: true });
    child = start(process.execPath,[join(fixture,".output/server/index.mjs")]);
    await eventually(async () => (await fetch(`${origin}/eve/v1/health`,{ signal: AbortSignal.timeout(1000) }).catch(() => null))?.ok ?? false,"Replacement runtime did not start.");
    const client = new Client({ host: origin, auth: { bearer: env.TEST_CAROL_TOKEN! }, redirect: "error" });
    const restored = client.sessions.attach(receipt.sessionId);
    const events = []; for await (const event of restored.stream({ follow: false })) events.push(event);
    assert.ok(events.some(event => event.type === "message.completed"));
    assert.equal(await lines(receipts),beforeRestart,"Replay must not re-run the model.");
    const followup = await (await restored.send("Continue after replacement")).result();
    assert.ok(followup.events.some(event => event.type === "message.completed"));
    assert.equal(await lines(receipts),beforeRestart+1);
    await eventually(async () => (await workflowRecovery(["list"])).lockedJobs.length === 0, "Completed follow-up job remained locked.");
    const interruptedInput = { message: "inflight-restart-test", operationId: randomUUID() };
    const beforeInterrupted = await lines(receipts);
    const beforeInterruptedBudget = await budgets.snapshot({ ...owner, now: Date.now() });
    await new BudgetedCreation(broker,budgets,budgetSettings.policy,() => 20).create(owner,interruptedInput);
    await eventually(async () => await lines(receipts) === beforeInterrupted+1, "Interrupted fixture model did not start.");
    const interruptedSession = await broker.read(owner,interruptedInput.operationId);
    assert.ok(interruptedSession.sessionId);
    assert.equal(await budgets.attemptCount({ ...owner, operationId: interruptedInput.operationId }),1);
    const interruptedExit = once(child,"exit"); child.kill("SIGKILL"); await interruptedExit;
    const locked = await workflowRecovery(["list"]);
    assert.equal(locked.jobPrefix,"isolated_fixture");
    assert.equal(locked.lockedJobs.length,1,"The interrupted Workflow job must remain locked by its dead worker.");
    const deadWorker = locked.lockedJobs[0].locked_by;
    const unconfirmed = spawn(process.execPath,[join(root,"scripts/recover-workflow.mjs"),"unlock","--worker-id",deadWorker],{ cwd: directory, env, stdio: "ignore" });
    assert.equal((await once(unconfirmed,"exit"))[0],2,"Unlock must require explicit dead-worker confirmation.");
    const unlocked = await workflowRecovery(["unlock","--worker-id",deadWorker,"--confirm-dead"]);
    assert.equal(unlocked.unlockedJobs,1);
    await rm(join(directory,"workflow"),{ recursive: true, force: true });
    child = start(process.execPath,[join(fixture,".output/server/index.mjs")]);
    await eventually(async () => (await fetch(`${origin}/eve/v1/health`,{ signal: AbortSignal.timeout(1000) }).catch(() => null))?.ok ?? false,"Runtime did not restart during an in-flight turn.");
    await writeFile(modelGate,"ready");
    await eventually(async () => (await store.listProjections(owner,interruptedInput.operationId,{})).items.some(entry => entry.payload.kind === "run" && entry.payload.state === "failed"),"Interrupted turn did not reach a failed boundary after restart.");
    assert.equal(await lines(receipts),beforeInterrupted+1,"An interrupted model attempt must not execute twice past its durable call cap.");
    assert.equal(await budgets.attemptCount({ ...owner, operationId: interruptedInput.operationId }),1);
    const afterInterrupted = await budgets.snapshot({ ...owner, now: Date.now() });
    assert.equal(afterInterrupted.active,0,"Failed replay must release its active budget reservation.");
    assert.equal(afterInterrupted.chargedMicros,60,"Unreported in-flight usage must retain the conservative estimate.");
    assert.equal(afterInterrupted.unknownCosts,beforeInterruptedBudget.unknownCosts+1);
    console.log("PostgreSQL Workflow: repeatable bootstrap, replay and follow-up after SIGKILL, plus fail-closed in-flight model restart passed.");
  }
  const callsBeforeApproval = await lines(receipts);
  const forgedApproval = await fetch(`${origin}/eve/v1/session/${loop.sessionId}`, { method: "POST", headers: { authorization: `Bearer ${bobToken}`, "content-type": "application/json" }, body: JSON.stringify({ inputResponses: [{ requestId: "forged-budget-increase", optionId: "approve" }] }) });
  assert.equal(forgedApproval.status,202);
  const bobClient = new Client({ host: origin, auth: { bearer: bobToken }, redirect: "error" });
  const loopSession = bobClient.sessions.attach(loop.sessionId);
  await loopSession.clear();
  await eventually(async () => {
    const events = []; for await (const event of loopSession.stream({ follow: false })) events.push(event.type);
    return events.includes("context.cleared");
  }, "The runtime did not process the control after the forged approval.");
  assert.equal(await lines(receipts),callsBeforeApproval);
  assert.equal(await budgets.attemptCount({ ...bob, operationId: loopInput.operationId }),1);
  console.log("Eve runtime: creation recovery, owned follow-up, compaction settlement, daily-budget and model-call caps, stale-response quota enforcement, owner isolation and revocation passed.");
} catch (error) {
  validationFailed = true;
  console.error(error instanceof Error ? error.message : "Session runtime validation failed.");
  for (const secret of secrets) diagnostics = diagnostics.replaceAll(secret, "[redacted]");
  console.error(diagnostics); process.exitCode = 1;
  if (postgresWorkflows) console.error("Fixture-only model receipts:", await readFile(receipts,"utf8").catch(() => "unavailable"));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child?.kill("SIGKILL"), 5000); await exited; clearTimeout(timer);
  }
  if (storesOpen) { await store.close(); await budgets.close(); }
  await rm(directory, { recursive: true, force: true });
  await workflowDatabase?.stop();
}
// The embedded database's subprocess cleanup can change process.exitCode.
process.exit(validationFailed || interrupted ? 1 : 0);
