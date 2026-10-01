import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes,randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "jumpstart-convex-"));
const cli = join(root, "node_modules/convex/bin/main.js");
const browserAccounts = process.argv.includes("--accounts");
const secret = randomBytes(32).toString("base64url");
const auditSecret = randomBytes(32).toString("base64url");
const erasureSecret = randomBytes(32).toString("base64url");
const env = { ...process.env, CONVEX_AGENT_MODE: "anonymous" };
// This harness must never inherit a real deployment or authentication context.
for (const name of ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "CONVEX_SELF_HOSTED_URL", "CONVEX_SELF_HOSTED_ADMIN_KEY",
  "CONVEX_BACKEND_SECRET","CONVEX_AUDIT_SECRET","CONVEX_ERASURE_SECRET"]) delete env[name];
async function freePort() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
const cloudPort = await freePort();
let sitePort = await freePort();
while (cloudPort === sitePort) sitePort = await freePort();
const siteUrl = `http://127.0.0.1:${sitePort}`;
let backend, activeChild, terminated = false, startupError;
let output = "";
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => { terminated = true; activeChild?.kill(signal); backend?.kill(signal); });
async function command(args, options = {}) {
  let diagnostic = "";
  activeChild = spawn(process.execPath, args, { cwd: directory, env, stdio: ["pipe", "pipe", "pipe"], ...options });
  if (options.input) activeChild.stdin.end(options.input); else activeChild.stdin.end();
  activeChild.stdout.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); if (options.log) process.stdout.write(chunk); });
  activeChild.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-4000); if (options.log) process.stderr.write(chunk); });
  const [code, signal] = await once(activeChild, "exit"); activeChild = undefined;
  if (code !== 0 || signal) throw new Error(`Convex test command failed (${signal ?? code}). ${diagnostic.replaceAll(secret,"[redacted]").replaceAll(auditSecret,"[redacted]").replaceAll(erasureSecret,"[redacted]")}`);
  return diagnostic;
}
try {
  await cp(join(root, "convex"), join(directory, "convex"), { recursive: true });
  await cp(join(root, "convex.json"), join(directory, "convex.json"));
  await mkdir(join(directory,"lib/request-limits"),{ recursive: true });
  await cp(join(root,"lib/request-limits/contract.ts"),join(directory,"lib/request-limits/contract.ts"));
  await mkdir(join(directory,"lib/preferences"),{ recursive: true });
  await cp(join(root,"lib/preferences/contract.ts"),join(directory,"lib/preferences/contract.ts"));
  await mkdir(join(directory, "lib/data"), { recursive: true });
  await cp(join(root, "lib/data/contract.ts"), join(directory, "lib/data/contract.ts"));
  await mkdir(join(directory, "lib/agent-access"), { recursive: true });
  await cp(join(root, "lib/agent-access/contract.ts"), join(directory, "lib/agent-access/contract.ts"));
  await cp(join(root,"lib/agent-access/run-contract.ts"),join(directory,"lib/agent-access/run-contract.ts"));
  await cp(join(root, "lib/agent-access/projection-contract.ts"), join(directory, "lib/agent-access/projection-contract.ts"));
  await cp(join(root, "lib/agent-access/artifact-contract.ts"), join(directory, "lib/agent-access/artifact-contract.ts"));
  await mkdir(join(directory, "lib/uploads"), { recursive: true });
  await cp(join(root, "lib/uploads/review-contract.ts"), join(directory, "lib/uploads/review-contract.ts"));
  await cp(join(root, "lib/uploads/schema.ts"), join(directory, "lib/uploads/schema.ts"));
  await cp(join(root, "lib/uploads/catalog-contract.ts"), join(directory, "lib/uploads/catalog-contract.ts"));
  await mkdir(join(directory, "lib/budgets"), { recursive: true });
  await cp(join(root, "lib/budgets/contract.ts"), join(directory, "lib/budgets/contract.ts"));
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "jumpstart-convex-contract-fixture", private: true, type: "module", dependencies: { convex: packageJson.dependencies.convex } }));
  await symlink(join(root, "node_modules"), join(directory, "node_modules"), "dir");
  // Port flags are supported by the pinned CLI. Temporary cwd and anonymous
  // mode isolate this backend from an operator's configured cloud deployment.
  backend = spawn(process.execPath, [cli, "dev", "--local-cloud-port", String(cloudPort), "--local-site-port", String(sitePort), "--tail-logs", "disable"], { cwd: directory, env, stdio: ["ignore", "pipe", "pipe"] });
  const capture = chunk => { output = (output + chunk.toString()).slice(-16_000); };
  backend.stdout.on("data", capture); backend.stderr.on("data", capture);
  backend.on("error", error => { startupError = error; });
  // A fresh CI runner may need to download both the local backend and dashboard.
  const startupTimeoutMs = 300_000;
  const deadline = Date.now() + startupTimeoutMs;
  while (!output.includes("Convex functions ready")) {
    if (output.includes("Found ") && output.includes("error") && output.includes("TypeScript typecheck")) throw new Error("Local Convex TypeScript validation failed.");
    if (terminated || startupError || backend.exitCode !== null || backend.signalCode !== null) throw new Error("Local Convex backend stopped before becoming ready.");
    if (Date.now() > deadline) throw new Error(`Local Convex startup exceeded ${startupTimeoutMs / 1000} seconds.`);
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  // Opt-in regeneration uses the disposable deployment, never operator credentials.
  if (process.argv.includes("--update-codegen")) await cp(join(directory, "convex/_generated"), join(root, "convex/_generated"), { recursive: true });
  await command([cli, "env", "set", "CONVEX_BACKEND_SECRET"], { input: secret });
  await command([cli, "env", "set", "CONVEX_AUDIT_SECRET"], { input: auditSecret });
  await command([cli, "env", "set", "CONVEX_ERASURE_SECRET"], { input: erasureSecret });
  const ready = await fetch(`${siteUrl}/app/records`, { method: "POST", headers: { "content-type": "application/json", "x-jumpstart-backend-key": secret }, body: JSON.stringify({ operation: "health" }), signal: AbortSignal.timeout(5000) });
  if (!ready.ok) throw new Error(`Local Convex readiness failed (${ready.status}).`);
  // Real deployment boundary: anonymous clients must not bypass the HTTP action
  // by naming an internal function through the public Convex query endpoint.
  const direct = await fetch(`http://127.0.0.1:${cloudPort}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "records:health", args: {}, format: "json" }), signal: AbortSignal.timeout(5000) });
  const directResult = await direct.json();
  if (direct.ok && directResult.status !== "error") throw new Error("Internal Convex query was publicly accessible.");
  const accessDirect = await fetch(`http://127.0.0.1:${cloudPort}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "access:ownsSession", args: { tenant: "victim", subject: "victim", sessionId: "session" }, format: "json" }), signal: AbortSignal.timeout(5000) });
  const accessResult = await accessDirect.json();
  if (accessDirect.ok && accessResult.status !== "error") throw new Error("Internal session access query was publicly accessible.");
  await command([join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "vitest.integration.config.ts"], {
    cwd: root, env: { ...env, DATA_PROVIDER: "convex", CONVEX_SITE_URL: siteUrl, CONVEX_BACKEND_SECRET: secret }, log: true,
  });
  const auditOwner = { tenant: "test-convex-audit",subject: "test-convex-audit" },auditId = randomUUID();
  const auditSeed = await fetch(`${siteUrl}/app/records`,{ method: "POST",headers: { "content-type": "application/json","x-jumpstart-backend-key": secret },
    body: JSON.stringify({ operation: "create",...auditOwner,id: auditId,title: "Audit fixture",content: "private" }),signal: AbortSignal.timeout(5000) });
  if (!auditSeed.ok) throw new Error("Local Convex audit fixture could not be created.");
  const auditOutput = await command([join(root,"node_modules/tsx/dist/cli.mjs"),"scripts/inspect-convex-account-data.ts","--read-only"],{
    cwd: root,env: { ...env,CONVEX_SITE_URL: siteUrl,CONVEX_AUDIT_SECRET: auditSecret,
      ACCOUNT_AUDIT_TENANT: auditOwner.tenant,ACCOUNT_AUDIT_SUBJECT: auditOwner.subject },
  });
  const auditReport = JSON.parse(auditOutput);
  if (auditReport.provider !== "convex" || auditReport.ownerRows.records !== 1 || auditReport.ownerRowTotal < 1 ||
      auditReport.applicationWriteFenced !== false)
    throw new Error("Local Convex audit did not count its persisted private record.");
  const auditObjects = join(directory,"audit-objects");await mkdir(auditObjects,{ mode: 0o700 });
  const closureOutput = await command([join(root,"node_modules/tsx/dist/cli.mjs"),"scripts/inspect-account-closure.ts",
    "--metadata","convex","--read-only"],{ cwd: root,env: { ...env,CONVEX_SITE_URL: siteUrl,
      CONVEX_AUDIT_SECRET: auditSecret,ACCOUNT_AUDIT_TENANT: auditOwner.tenant,ACCOUNT_AUDIT_SUBJECT: auditOwner.subject,
      AUTH_PROVIDER: "api-key",UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: auditObjects } });
  const closureReport = JSON.parse(closureOutput);
  if (closureReport.status !== "retained_or_unattributable" || closureReport.ownerRows.records !== 1 ||
      closureReport.objectCount !== 0) throw new Error("Local Convex closure observation did not combine its row and object probes.");
  const deniedFence = await fetch(`${siteUrl}/app/audit`,{ method: "POST",headers: { "content-type": "application/json","x-jumpstart-backend-key": secret },
    body: JSON.stringify({ operation: "setAccountFence",...auditOwner }),signal: AbortSignal.timeout(5000) });
  if (deniedFence.status !== 401) throw new Error("Application backend credential reached the Convex audit fence.");
  const fenceOutput = await command([join(root,"node_modules/tsx/dist/cli.mjs"),"scripts/fence-account-writes.ts",
    "--metadata","convex","--set-permanent"],{ cwd: root,env: { ...env,CONVEX_SITE_URL: siteUrl,
      CONVEX_AUDIT_SECRET: auditSecret,ACCOUNT_AUDIT_TENANT: auditOwner.tenant,ACCOUNT_AUDIT_SUBJECT: auditOwner.subject } });
  const fenceReport = JSON.parse(fenceOutput);
  if (fenceReport.provider !== "convex" || fenceReport.status !== "fenced" || fenceReport.created !== true ||
      fenceOutput.includes(auditOwner.subject)) throw new Error("Local Convex operator fence failed or exposed its owner.");
  const fencedClosureOutput = await command([join(root,"node_modules/tsx/dist/cli.mjs"),"scripts/inspect-account-closure.ts",
    "--metadata","convex","--read-only"],{ cwd: root,env: { ...env,CONVEX_SITE_URL: siteUrl,
      CONVEX_AUDIT_SECRET: auditSecret,ACCOUNT_AUDIT_TENANT: auditOwner.tenant,ACCOUNT_AUDIT_SUBJECT: auditOwner.subject,
      AUTH_PROVIDER: "api-key",UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: auditObjects } });
  const fencedClosure = JSON.parse(fencedClosureOutput);
  if (fencedClosure.applicationWriteFenced !== true || fencedClosure.remaining.applicationWritesPossible !== false)
    throw new Error("Local Convex closure observation did not see the permanent application-row fence.");
  const rowArchive = join(directory,"account-rows.ndjson");
  const rowOutput = await command([join(root,"node_modules/tsx/dist/cli.mjs"),"scripts/export-account-rows.ts",
    "--metadata","convex","--output",rowArchive,"--stopped"],{ cwd: root,env: { ...env,CONVEX_SITE_URL: siteUrl,
      CONVEX_AUDIT_SECRET: auditSecret,ACCOUNT_AUDIT_TENANT: auditOwner.tenant,ACCOUNT_AUDIT_SUBJECT: auditOwner.subject } });
  if (JSON.parse(rowOutput).rows !== 1 || rowOutput.includes(auditOwner.subject))
    throw new Error("Local Convex row export did not preserve only the audit owner.");
  const verifiedRows = JSON.parse(await command([join(root,"node_modules/tsx/dist/cli.mjs"),
    "scripts/export-account-rows.ts","--verify",rowArchive],{ cwd: root,env }));
  if (verifiedRows.provider !== "convex" || verifiedRows.rows !== 1 ||
      !(await readFile(rowArchive,"utf8")).includes(auditId))
    throw new Error("Local Convex raw row archive did not verify.");
  const archivedRecord = (await readFile(rowArchive,"utf8")).split("\n")
    .filter(Boolean).map(line => JSON.parse(line)).find(item => item.type === "row" && item.value.entity === "records");
  const internalRecordId = JSON.parse(archivedRecord.value.rowJson)._id;
  const directErase = await fetch(`http://127.0.0.1:${cloudPort}/api/mutation`,{ method: "POST",
    headers: { "content-type": "application/json" },body: JSON.stringify({ path: "audit:eraseAccountRows",
      args: { entity: "records",...auditOwner,ids: [internalRecordId] },format: "json" }),signal: AbortSignal.timeout(5000) });
  const directEraseResult = await directErase.json();
  if (directErase.ok && directEraseResult.status !== "error")
    throw new Error("Internal Convex erasure mutation was publicly accessible.");
  const bundle = join(directory,"account-bundle");
  const bundleEnv = { ...env,CONVEX_SITE_URL: siteUrl,CONVEX_AUDIT_SECRET: auditSecret,
    ACCOUNT_AUDIT_TENANT: auditOwner.tenant,ACCOUNT_AUDIT_SUBJECT: auditOwner.subject,
    UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: auditObjects };
  const bundleOutput = await command([join(root,"node_modules/tsx/dist/cli.mjs"),"scripts/export-account-bundle.ts",
    "--metadata","convex","--output",bundle,"--stopped"],{ cwd: root,env: bundleEnv });
  const bundleReport = JSON.parse(bundleOutput);
  if (bundleReport.rows !== 1 || bundleReport.objects !== 0 || bundleOutput.includes(auditOwner.subject))
    throw new Error("Local Convex account bundle omitted rows or exposed its owner.");
  const verifiedBundle = JSON.parse(await command([join(root,"node_modules/tsx/dist/cli.mjs"),
    "scripts/export-account-bundle.ts","--verify",bundle],{ cwd: root,env }));
  if (verifiedBundle.metadataProvider !== "convex" || verifiedBundle.rows !== 1 || verifiedBundle.objects !== 0)
    throw new Error("Local Convex account bundle did not verify.");
  const lateWrite = await fetch(`${siteUrl}/app/records`,{ method: "POST",headers: { "content-type": "application/json","x-jumpstart-backend-key": secret },
    body: JSON.stringify({ operation: "create",...auditOwner,id: randomUUID(),title: "Late",content: "private" }),signal: AbortSignal.timeout(5000) });
  if (lateWrite.status !== 500) throw new Error("Local Convex accepted a fenced account write.");
  const retained = await fetch(`${siteUrl}/app/records`,{ method: "POST",headers: { "content-type": "application/json","x-jumpstart-backend-key": secret },
    body: JSON.stringify({ operation: "get",...auditOwner,id: auditId }),signal: AbortSignal.timeout(5000) });
  if (!retained.ok || (await retained.json()).title !== "Audit fixture") throw new Error("Local Convex fenced account lost read access.");
  const otherWrite = await fetch(`${siteUrl}/app/records`,{ method: "POST",headers: { "content-type": "application/json","x-jumpstart-backend-key": secret },
    body: JSON.stringify({ operation: "create",tenant: auditOwner.tenant,subject: "other",id: randomUUID(),title: "Other",content: "private" }),signal: AbortSignal.timeout(5000) });
  if (!otherWrite.ok) throw new Error("Local Convex fence blocked a different account.");
  const deniedErase = await fetch(`${siteUrl}/app/audit`,{ method: "POST",headers: {
    "content-type": "application/json","x-jumpstart-audit-key": auditSecret },
    body: JSON.stringify({ operation: "eraseAccountRows",entity: "records",...auditOwner,ids: ["invalid"] }),
    signal: AbortSignal.timeout(5000) });
  if (deniedErase.status !== 401) throw new Error("Convex audit credential alone could erase account rows.");
  const planOutput = await command([join(root,"node_modules/tsx/dist/cli.mjs"),"scripts/erase-account-rows.ts",
    "--metadata","convex","--source",bundle,"--stopped","--plan"],{ cwd: root,env: bundleEnv });
  if (JSON.parse(planOutput).remainingBefore !== 1 || planOutput.includes(auditOwner.subject))
    throw new Error("Local Convex erasure plan did not verify its fenced bundle privately.");
  const erasedOutput = await command([join(root,"node_modules/tsx/dist/cli.mjs"),"scripts/erase-account-rows.ts",
    "--metadata","convex","--source",bundle,"--stopped","--erase-application-rows"],{
    cwd: root,env: { ...bundleEnv,CONVEX_ERASURE_SECRET: erasureSecret } });
  if (JSON.parse(erasedOutput).deleted !== 1 || erasedOutput.includes(auditOwner.subject))
    throw new Error("Local Convex operator erasure failed or exposed its owner.");
  const afterErase = await command([join(root,"node_modules/tsx/dist/cli.mjs"),"scripts/inspect-convex-account-data.ts","--read-only"],{
    cwd: root,env: { ...bundleEnv } });
  if (JSON.parse(afterErase).ownerRowTotal !== 0) throw new Error("Local Convex owner rows remain after erasure.");
  console.log("Local Convex: real backend contract and internal-function isolation passed.");
  if (browserAccounts) {
    const browserEnv = { ...env,CONVEX_SITE_URL: siteUrl,CONVEX_BACKEND_SECRET: secret,TEST_DISPOSABLE_CONVEX: "1" };
    for (const flags of [[],["--chat"],["--chat","--uploads"],
      ["--storage-supabase"],["--chat","--uploads","--storage-supabase"]]) {
      await command([join(root,"scripts/test-auth.mjs"),"--convex",...flags],{
        cwd: root,env: browserEnv,log: true,
      });
    }
    console.log("Local Convex: signed-in account, chat and reviewed-upload browser contracts passed with local and Supabase Storage.");
  }
} catch (error) {
  // Only the local dev service output is included; key-setting commands are not logged.
  console.error(error instanceof Error ? error.message : "Convex validation failed.");
  console.error(output.replaceAll(secret,"[redacted]").replaceAll(auditSecret,"[redacted]").replaceAll(erasureSecret,"[redacted]"));
  process.exitCode = 1;
} finally {
  if (backend && backend.exitCode === null && backend.signalCode === null) {
    const exited = once(backend, "exit");
    backend.kill("SIGTERM");
    const timeout = setTimeout(() => backend.kill("SIGKILL"), 5000);
    await exited; clearTimeout(timeout);
  }
  await rm(directory, { recursive: true, force: true });
}
