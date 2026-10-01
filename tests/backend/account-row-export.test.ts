import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { expect,it,vi,afterEach } from "vitest";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { setSqliteAccountFence,setConvexAccountFence } from "../../scripts/fence-account-writes";
import { accountOwnerRowQueries } from "../../scripts/account-data-inventory.mjs";
import { exportAccountRows,exportSelectedAccountRows,verifyAccountRowExport } from "../../scripts/export-account-rows";

const modules = import.meta.glob("../../convex/**/*.ts");
const alice = { tenant: "private-tenant",subject: "private-alice" },bob = { ...alice,subject: "private-bob" };
const auditSecret = "test-private-row-export-secret-".repeat(2);
afterEach(() => vi.unstubAllEnvs());

it("exports every fenced SQLite owner row, including descendants, without the other owner's rows",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-row-export-")),path = join(dir,"app.sqlite"),output = join(dir,"rows.ndjson");
  try {
    const stores = [new SqliteRepository(path),sqliteAccessStore(path),sqliteBudgetStore(path),
      sqliteUploadCatalog(path),sqlitePreferenceStore(path),sqliteRequestLimitStore(path)];
    for (const store of stores) await store.close();
    const db = new DatabaseSync(path);
    try {
      db.prepare("INSERT INTO app_records VALUES('a',?,?,'Alice','private content',1,'now','now')").run(alice.tenant,alice.subject);
      db.prepare("INSERT INTO app_records VALUES('b',?,?,'Bob','foreign content',1,'now','now')").run(bob.tenant,bob.subject);
      db.prepare("INSERT INTO app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status) VALUES('oa',?,?,'hash','policy',1,1,1,'reserved')").run(alice.tenant,alice.subject);
      db.exec("INSERT INTO app_budget_attempts VALUES('oa','alice-attempt')");
    } finally { db.close(); }
    await expect(exportSelectedAccountRows("sqlite",alice,output,{ ACCOUNT_AUDIT_SQLITE_PATH: path }))
      .rejects.toThrow("fenced");
    expect(readdirSync(dir)).not.toContain("rows.ndjson");
    setSqliteAccountFence(path,alice);
    expect(await exportSelectedAccountRows("sqlite",alice,output,{ ACCOUNT_AUDIT_SQLITE_PATH: path }))
      .toEqual({ provider: "sqlite",rows: 3 });
    expect(await verifyAccountRowExport(output)).toEqual({ provider: "sqlite",rows: 3 });
    expect(statSync(output).mode & 0o077).toBe(0);
    const lines = readFileSync(output,"utf8").trimEnd().split("\n").map(line => JSON.parse(line));
    expect(lines[0].value.owner).toEqual(alice);
    expect(lines.at(-1).value.counts).toMatchObject({ records: 1,budgetReservations: 1,budgetAttempts: 1 });
    expect(lines.filter(line => line.type === "row").map(line => line.value.entity)).toEqual(["records","budgetReservations","budgetAttempts"]);
    expect(readFileSync(output,"utf8")).toContain("private content");
    expect(readFileSync(output,"utf8")).not.toContain("foreign content");
    await expect(exportSelectedAccountRows("sqlite",alice,output,{ ACCOUNT_AUDIT_SQLITE_PATH: path })).rejects.toThrow();
    const cliArchive = join(dir,"cli.ndjson"),argv = ["node_modules/tsx/dist/cli.mjs","scripts/export-account-rows.ts",
      "--metadata","sqlite","--output",cliArchive,"--stopped"];
    const env = { ...process.env,ACCOUNT_AUDIT_TENANT: alice.tenant,ACCOUNT_AUDIT_SUBJECT: alice.subject,
      ACCOUNT_AUDIT_SQLITE_PATH: path };
    const noStop = spawnSync(process.execPath,argv.slice(0,-1),{ cwd: process.cwd(),encoding: "utf8",env });
    expect(noStop.status).toBe(2);
    expect(readdirSync(dir)).not.toContain("cli.ndjson");
    const cli = spawnSync(process.execPath,argv,{ cwd: process.cwd(),encoding: "utf8",env });
    expect(cli.status).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual({ provider: "sqlite",rows: 3 });
    expect(cli.stdout).not.toContain(alice.subject);
    const verified = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/export-account-rows.ts",
      "--verify",cliArchive],{ cwd: process.cwd(),encoding: "utf8" });
    expect(verified.status).toBe(0);
    expect(JSON.parse(verified.stdout)).toEqual({ provider: "sqlite",rows: 3 });
    const changed = readFileSync(output,"utf8").replace("private content","altered content");
    const tampered = join(dir,"tampered.ndjson");
    writeFileSync(tampered,changed,{ mode: 0o600 });
    await expect(verifyAccountRowExport(tampered)).rejects.toThrow("digest");
    if (process.platform !== "win32") {
      const fifo = join(dir,"rows.fifo"),created = spawnSync("mkfifo",[fifo],{ encoding: "utf8" });
      expect(created.status,created.stderr).toBe(0);
      const rejected = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/export-account-rows.ts",
        "--verify",fifo],{ cwd: process.cwd(),encoding: "utf8",timeout: 5000 });
      expect(rejected.error).toBeUndefined();
      expect(rejected.status).toBe(1);
    }
    const forged = structuredClone(lines);
    const record = forged.find(line => line.type === "row" && line.value.entity === "records");
    record.value.rowJson = record.value.rowJson.replace(alice.subject,bob.subject);
    const content = forged.slice(0,-1).map(line => JSON.stringify(line)+"\n").join("");
    forged.at(-1).value.contentSha256 = createHash("sha256").update(content).digest("hex");
    const wrongOwner = join(dir,"wrong-owner.ndjson");
    writeFileSync(wrongOwner,content+JSON.stringify(forged.at(-1))+"\n",{ mode: 0o600 });
    await expect(verifyAccountRowExport(wrongOwner)).rejects.toThrow("invalid row");
    chmodSync(tampered,0o644);
    await expect(verifyAccountRowExport(tampered)).rejects.toThrow("unsafe");
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});

it("does not publish a partial row archive when a classified count is missing",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-row-export-fail-")),output = join(dir,"rows.ndjson");
  try {
    const counts = Object.fromEntries(accountOwnerRowQueries("sqlite").map(query =>
      [query.entity,query.entity === "records" ? 2 : 0]));
    const source = { provider: "sqlite" as const,counts,consistency: "fixture",
      async *rows() { yield { entity: "records",rowJson: JSON.stringify(alice) }; },
      async verify() {},async close() {} };
    await expect(exportAccountRows(source,alice,output)).rejects.toThrow("count changed");
    expect(readdirSync(dir)).not.toContain("rows.ndjson");
    expect(readdirSync(dir).some(name => name.startsWith(".jumpstart-row-export-"))).toBe(false);
    const escaped = { ...source,counts: { ...counts,records: 1 },
      async *rows() { yield { entity: "records",rowJson: JSON.stringify({ ...alice,content: "\\".repeat(600_000) }) }; } };
    await expect(exportAccountRows(escaped,alice,output)).resolves.toEqual({ provider: "sqlite",rows: 1 });
    await expect(verifyAccountRowExport(output)).resolves.toEqual({ provider: "sqlite",rows: 1 });
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});

it("exports fenced Convex rows through the operator credential and refuses global orphans",async () => {
  vi.stubEnv("CONVEX_AUDIT_SECRET",auditSecret);
  vi.stubEnv("CONVEX_BACKEND_SECRET","test-application-secret-".repeat(2));
  const backend = convexTest(schema,modules),dir = mkdtempSync(join(tmpdir(),"jumpstart-convex-row-export-"));
  const output = join(dir,"rows.ndjson"),request: typeof fetch = (url,init) =>
    backend.fetch(new URL(url instanceof Request ? url.url : url).pathname,init);
  try {
    await backend.mutation(internal.records.create,{ ...alice,id: crypto.randomUUID(),title: "Alice",content: "private alice" });
    await backend.mutation(internal.records.create,{ ...bob,id: crypto.randomUUID(),title: "Bob",content: "private bob" });
    await backend.run(async ctx => {
      for (let index = 0;index < 22;index++) await ctx.db.insert("records",{
        ...alice,id: crypto.randomUUID(),title: "Alice "+index,content: "private alice",
        revision: 1,createdAt: "now",updatedAt: "now" });
    });
    await expect(exportSelectedAccountRows("convex",alice,output,{ CONVEX_SITE_URL: "https://test.convex.site",
      CONVEX_AUDIT_SECRET: auditSecret },request)).rejects.toThrow("fenced");
    await setConvexAccountFence("https://test.convex.site",auditSecret,alice,request);
    expect(await exportSelectedAccountRows("convex",alice,output,{ CONVEX_SITE_URL: "https://test.convex.site",
      CONVEX_AUDIT_SECRET: auditSecret },request)).toEqual({ provider: "convex",rows: 23 });
    expect(await verifyAccountRowExport(output)).toEqual({ provider: "convex",rows: 23 });
    expect(readFileSync(output,"utf8")).toContain("private alice");
    expect(readFileSync(output,"utf8")).not.toContain("private bob");
    const denied = await backend.fetch("/app/audit",{ method: "POST",headers: {
      "content-type": "application/json","x-jumpstart-backend-key": "test-application-secret-".repeat(2) },
      body: JSON.stringify({ operation: "accountRowPage",entity: "records",...alice,cursor: null }) });
    expect(denied.status).toBe(401);
    await backend.run(async ctx => { await ctx.db.insert("conversationEvents",{ operationId: "orphan",eventId: "orphan",ordinal: 1,payload: "private" }); });
    const later = join(dir,"later.ndjson");
    await expect(exportSelectedAccountRows("convex",alice,later,{ CONVEX_SITE_URL: "https://test.convex.site",
      CONVEX_AUDIT_SECRET: auditSecret },request)).rejects.toThrow("Unattributable");
    expect(readdirSync(dir)).not.toContain("later.ndjson");
  } finally { rmSync(dir,{ recursive: true,force: true }); }
});
