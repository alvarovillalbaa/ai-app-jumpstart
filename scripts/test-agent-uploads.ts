import assert from "node:assert/strict";
import { randomBytes,randomUUID } from "node:crypto";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client,type InputRequest } from "eve/client";
import { startChatFixture } from "./helpers/eve-chat-fixture.mjs";
import { uploadScannerFixture } from "./helpers/upload-scanner-fixture.mjs";
import { sqliteAccessStore } from "../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../lib/budgets/sqlite";
import { runtimeReservationPolicy,parseRuntimeBudgetSettings } from "../lib/budgets/runtime";
import { BudgetedCreation } from "../lib/budgets/creation";
import { ConversationBroker,creationTransport } from "../lib/agent-access/broker";
import { sqliteUploadCatalog } from "../lib/uploads/catalog-sqlite";
import { localUploadObjects } from "../lib/uploads/local";
import { UploadIntake } from "../lib/uploads/intake";
import { UploadService } from "../lib/uploads/service";
import { createUploadScanner } from "../lib/uploads/scanner";

const root = fileURLToPath(new URL("../",import.meta.url)),directory = await mkdtemp(join(tmpdir(),"jagent-"));
const socketPath = join(directory,"scan.sock"),control = join(directory,"verdict"),database = join(directory,"app.sqlite");
const portServer = createServer();portServer.listen(0,"127.0.0.1");await once(portServer,"listening");
const address = portServer.address();if (!address || typeof address === "string") throw new Error("Fixture port unavailable.");
const origin = `http://127.0.0.1:${address.port}`;await new Promise<void>(resolve => portServer.close(() => resolve()));
const owner = { tenant: "fixture",subject: "alice" },aliceToken = randomBytes(32).toString("hex"),bobToken = randomBytes(32).toString("hex");
const signing = { audience: "isolated-session-runtime",activeKey: "fixture",keys: { fixture: randomBytes(32).toString("hex") } };
const budgetSettings = parseRuntimeBudgetSettings({ policy: { id: "upload-fixture",dailyMicros: 1000,maxActive: 2,maxPerMinute: 100 },
  estimateMicros: 20,maxModelCalls: 2,maxInputBytes: 65536,modelIds: ["openai/gpt-5.6-luna-fast"],
  costBasis: { sourceUrl: "https://example.test/fixture-prices",reviewedAt: "2026-09-24",maxOtherMicros: 0,
    models: [{ id: "openai/gpt-5.6-luna-fast",maxInputTokens: 4096,maxOutputTokens: 1024,inputMicrosPerMillion: 1,outputMicrosPerMillion: 1 }] } });
const env = Object.fromEntries(["PATH","HOME","TMPDIR","SystemRoot","CI"].flatMap(key => process.env[key] ? [[key,process.env[key]!]] : []));
Object.assign(env,{ NODE_ENV: "production",APP_ORIGIN: origin,DATA_PROVIDER: "sqlite",SQLITE_PATH: database,
  UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: join(directory,"objects"),UPLOAD_DOWNLOAD_POLICY: "scan-on-read",
  UPLOAD_AGENT_POLICY: "reviewed-text",UPLOAD_SCANNER_PROVIDER: "clamd",UPLOAD_CLAMD_SOCKET: socketPath,
  TEST_ALICE_TOKEN: aliceToken,TEST_BOB_TOKEN: bobToken,TEST_SIGNING_KEY: signing.keys.fixture,TEST_DEFAULT_PROVIDER: "1",
  AI_BUDGET_POLICY_JSON: JSON.stringify(budgetSettings) });
const access = sqliteAccessStore(database),budgets = sqliteBudgetStore(database),catalog = sqliteUploadCatalog(database);
const objects = localUploadObjects(env.UPLOAD_LOCAL_ROOT);
const uploads = new UploadService(catalog,async () => objects,{ ...owner,scopes: ["uploads:read","uploads:write","uploads:download"] },() => createUploadScanner(env),env.UPLOAD_DOWNLOAD_POLICY);
let runtime: Awaited<ReturnType<typeof startChatFixture>> | undefined,scanner: Awaited<ReturnType<typeof uploadScannerFixture>> | undefined;
async function bounded<T>(work: Promise<T>,label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work,new Promise<never>((_,reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)),60000); })]); }
  finally { clearTimeout(timer); }
}
try {
  await writeFile(control,"clean",{ mode: 0o600 });scanner = await uploadScannerFixture(socketPath,control);
  runtime = await startChatFixture(root,directory,env,{ fixtureChannel: true,
    routesManifest: { rewrites: { beforeFiles: [{ source: "/eve/v1/:path+",destination: `${origin}/eve/v1/:path+` }] } } });
  const client = new Client({ host: origin,auth: { bearer: aliceToken },redirect: "error" });
  const broker = new ConversationBroker(access,creationTransport(origin,signing));
  const creation = new BudgetedCreation(broker,budgets,runtimeReservationPolicy(budgetSettings),() => budgetSettings.estimateMicros);
  // Native reads are proved by persisted scan timestamps and exact tool results.
  for (const scenario of ["approve","deny","revoke","reject","outage","foreign"] as const) {
    await writeFile(control,"clean");
    const text = `Private reviewed source ${scenario} 📝\n<script>never execute me</script>`;
    const uploadOwner = scenario === "foreign" ? { ...owner,subject: "bob" } : owner;
    const row = await new UploadIntake(catalog,objects).accept(uploadOwner,"source.txt","text/plain",new TextEncoder().encode(text));
    const scoped = scenario === "foreign" ? new UploadService(catalog,async () => objects,{ ...uploadOwner,scopes: ["uploads:read","uploads:write","uploads:download"] },() => createUploadScanner(env),env.UPLOAD_DOWNLOAD_POLICY) : uploads;
    await scoped.decideReview(row.id,{ sha256: row.sha256,revision: 0,approved: true });
    const before = await catalog.get(uploadOwner,row.id);
    const reference = { id: row.id,sha256: row.sha256,reviewRevision: 1 },operation = randomUUID();
    await creation.create(owner,{ operationId: operation,message: `agent-upload-fixture ${JSON.stringify(reference)}` });
    let sessionId: string | undefined;
    const deadline = Date.now()+60000;
    while (Date.now()<deadline) {
      const receipt = await broker.read(owner,operation);
      if (receipt.status === "active") { sessionId = receipt.sessionId;break; }
      await new Promise(resolve => setTimeout(resolve,50));
    }
    assert.ok(sessionId,"Owned runtime receipt not bound.");
    const session = client.sessions.attach(sessionId),events: unknown[] = [];
    let requests: readonly InputRequest[] = [];
    await bounded((async () => {
      for await (const event of session.stream()) {
        events.push(event);
        if (event.type === "input.requested") requests = event.data.requests;
        if (event.type === "session.waiting" || event.type === "session.failed") break;
      }
    })(),"Initial upload turn");
    assert.equal(JSON.stringify(events).includes(text.split("\n")[0]),false,"Private bytes escaped before approval.");
    if (scenario === "foreign") { assert.equal(requests.length,0);continue; }
    assert.equal(requests.length,1,"Expected one native approval.");
    assert.equal((await catalog.get(owner,row.id))!.scan!.checkedAt,before!.scan!.checkedAt,"Approval request fetched/scanned bytes.");
    const forged = await fetch(`${origin}/eve/v1/session/${sessionId}`,{ method: "POST",headers: { authorization: `Bearer ${bobToken}`,"content-type": "application/json" },
      body: JSON.stringify({ inputResponses: [{ requestId: requests[0].requestId,optionId: "approve" }] }),signal: AbortSignal.timeout(5000) });
    assert.equal(forged.status,401);
    if (scenario === "revoke") await uploads.decideReview(row.id,{ sha256: row.sha256,revision: 1,approved: false });
    if (scenario === "reject") await catalog.recordScan(owner,row.id,{ status: "rejected",reason: "malware",sha256: row.sha256,checkedAt: Date.now(),policyVersion: 1 });
    if (scenario === "outage") await writeFile(control,"outage");
    const resumed = await bounded((async () => (await session.respond([{ requestId: requests[0].requestId,optionId: scenario === "deny" ? "cancel" : "approve" }])).result())(),"Upload approval continuation");
    assert.equal(JSON.stringify(resumed).includes(text.split("\n")[0]),scenario === "approve","Unexpected model-facing private text.");
    if (scenario === "approve") {
      assert.ok(JSON.stringify(resumed).includes("untrusted-user-content"));
      assert.ok(resumed.message?.includes(JSON.stringify(text)),"Model did not receive exact Unicode/newline source text.");
      assert.ok((await catalog.get(owner,row.id))!.scan!.checkedAt>before!.scan!.checkedAt,"Native read did not obtain a fresh scan.");
      const again = await bounded((async () => (await session.send(`agent-upload-fixture ${JSON.stringify(reference)}`)).result())(),"Repeat private upload request");
      const next = again.events.find(event => event.type === "input.requested");
      assert.ok(next && next.type === "input.requested" && next.data.requests.length === 1,"A second read reused an approval grant.");
      assert.equal(JSON.stringify(again).includes(text.split("\n")[0]),false,"A second read released text before new approval.");
      const cancelled = await bounded((async () => (await session.respond([{ requestId: next.data.requests[0].requestId,optionId: "cancel" }])).result())(),"Repeat read denial");
      assert.equal(JSON.stringify(cancelled).includes(text.split("\n")[0]),false);
    }
  }
  console.log("Compiled Eve reviewed-upload contracts passed: explicit approval, denial, foreign responder/upload, revocation, rejection, scanner outage and exact untrusted text.");
} finally {
  await runtime?.stop();await scanner?.stop();await access.close();await budgets.close();await catalog.close();
  await rm(directory,{ recursive: true,force: true });
}
