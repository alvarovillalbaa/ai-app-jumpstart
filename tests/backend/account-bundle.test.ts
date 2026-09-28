import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createHash,randomUUID } from "node:crypto";
import { chmodSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convexTest } from "convex-test";
import { expect,it,vi } from "vitest";
import schema from "../../convex/schema";
import { internal } from "../../convex/_generated/api";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { uploadObjectKey } from "../../lib/uploads/contract";
import { localUploadObjects } from "../../lib/uploads/local";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { exportAccountBundle,verifyAccountBundle } from "../../scripts/export-account-bundle";
import { setConvexAccountFence,setSqliteAccountFence } from "../../scripts/fence-account-writes";
import { rehearseAccountBundle,verifyRehearsedAccountBundle } from "../../scripts/rehearse-account-bundle";

const alice = { tenant: "bundle-tenant",subject: "bundle-alice" };
const bob = { ...alice,subject: "bundle-bob" };
const modules = import.meta.glob("../../convex/**/*.ts");

it("bundles fenced owner rows and private bytes, preserving object orphans and rejecting mismatches",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-account-bundle-"));
  const path = join(dir,"app.sqlite"),root = join(dir,"objects"),output = join(dir,"bundle");
  const id = randomUUID(),orphan = randomUUID(),foreignId = randomUUID();
  const bytes = Buffer.from("Alice private upload bytes");
  try {
    const stores = [new SqliteRepository(path),sqliteAccessStore(path),sqliteBudgetStore(path),
      sqliteUploadCatalog(path),sqlitePreferenceStore(path),sqliteRequestLimitStore(path)];
    for (const store of stores) await store.close();
    const db = new DatabaseSync(path);
    try {
      db.prepare("INSERT INTO app_records VALUES('alice-record',?,?,'Alice','Alice private record',1,'now','now')")
        .run(alice.tenant,alice.subject);
      db.prepare("INSERT INTO app_records VALUES('bob-record',?,?,'Bob','Bob private record',1,'now','now')")
        .run(bob.tenant,bob.subject);
      db.prepare("INSERT INTO app_uploads VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id,alice.tenant,alice.subject,"alice.txt","text/plain",bytes.length,
          createHash("sha256").update(bytes).digest("hex"),1,"quarantined");
      db.prepare("INSERT INTO app_uploads VALUES(?,?,?,?,?,?,?,?,?)")
        .run(foreignId,bob.tenant,bob.subject,"bob.txt","text/plain",bytes.length,
          createHash("sha256").update(bytes).digest("hex"),1,"quarantined");
      db.prepare("INSERT INTO app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status) VALUES(?,?,?,?,?,?,?,?,?)")
        .run("alice-operation",alice.tenant,alice.subject,"hash","policy",BigInt("9007199254740993"),1,1,"reserved");
      db.prepare("INSERT INTO app_budget_attempts VALUES('alice-operation','alice-attempt')").run();
    } finally { db.close(); }
    const objects = localUploadObjects(root);
    await objects.put(alice,id,bytes);
    await objects.put(alice,orphan,Buffer.from("orphan private bytes"));
    await objects.put(bob,foreignId,Buffer.from("different Bob bytes"));
    setSqliteAccountFence(path,alice);
    const env = { ACCOUNT_AUDIT_SQLITE_PATH: path,UPLOAD_LOCAL_ROOT: root };
    await expect(exportAccountBundle("sqlite","local",alice,join(root,"nested"),env))
      .rejects.toThrow("inside its object source");
    expect(readdirSync(root)).not.toContain("nested");
    await expect(exportAccountBundle("sqlite","local",alice,output,env))
      .resolves.toMatchObject({ metadataProvider: "sqlite",objectProvider: "local",rows: 4,objects: 2,
        catalog: { catalogRows: 1,activeRows: 1,objectOrphans: 1,transitionalWithoutBytes: 0 } });
    expect(await verifyAccountBundle(output)).toMatchObject({ rows: 4,objects: 2,
      objectSourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(readdirSync(output).sort()).toEqual(["manifest.json","objects.ndjson","rows.ndjson"]);
    expect(statSync(output).mode & 0o077).toBe(0);
    for (const name of readdirSync(output)) expect(statSync(join(output,name)).mode & 0o077).toBe(0);
    const content = readdirSync(output).map(name => readFileSync(join(output,name),"utf8")).join("\n");
    expect(content).toContain("Alice private record");
    expect(content).toContain(orphan);
    expect(content).not.toContain("Bob private record");
    expect(content).not.toContain(foreignId);
    const restored = join(dir,"restored");
    await expect(rehearseAccountBundle(output,restored)).resolves.toEqual({
      provider: "sqlite",rows: 4,objects: 2,status: "fenced-rehearsal" });
    await expect(verifyRehearsedAccountBundle(output,restored)).resolves.toMatchObject({ rows: 4,objects: 2 });
    const rehearsalDb = new DatabaseSync(join(restored,"app.sqlite"));
    try {
      expect(rehearsalDb.prepare("SELECT content FROM app_records WHERE tenant=? AND subject=?")
        .get(alice.tenant,alice.subject)).toEqual({ content: "Alice private record" });
      expect(rehearsalDb.prepare("SELECT count(*) AS count FROM app_records WHERE subject=?")
        .get(bob.subject)).toEqual({ count: 0 });
      const amount = rehearsalDb.prepare("SELECT estimate_micros FROM app_budget_reservations WHERE operation_id='alice-operation'");
      amount.setReadBigInts(true);
      expect(amount.get()).toEqual({ estimate_micros: BigInt("9007199254740993") });
      expect(rehearsalDb.prepare("SELECT attempt_id FROM app_budget_attempts WHERE operation_id='alice-operation'")
        .get()).toEqual({ attempt_id: "alice-attempt" });
      expect(() => rehearsalDb.prepare("INSERT INTO app_records VALUES('late',?,?,'Late','No',1,'now','now')")
        .run(alice.tenant,alice.subject)).toThrow("fenced");
    } finally { rehearsalDb.close(); }
    expect(await localUploadObjects(join(restored,"uploads")).get(alice,id)).toEqual(bytes);
    expect(await localUploadObjects(join(restored,"uploads")).get(alice,orphan))
      .toEqual(Buffer.from("orphan private bytes"));
    const verifyCli = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/rehearse-account-bundle.ts",
      "--verify",output,restored],{ cwd: process.cwd(),encoding: "utf8" });
    expect(verifyCli.status).toBe(0);
    expect(JSON.parse(verifyCli.stdout)).toMatchObject({ rows: 4,objects: 2 });
    const cliRestored = join(dir,"cli-restored");
    const restoreCli = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/rehearse-account-bundle.ts",
      "--source",output,"--output",cliRestored],{ cwd: process.cwd(),encoding: "utf8" });
    expect(restoreCli.status).toBe(0);
    expect(JSON.parse(restoreCli.stdout)).toMatchObject({ rows: 4,objects: 2,status: "fenced-rehearsal" });
    await expect(verifyRehearsedAccountBundle(output,cliRestored)).resolves.toMatchObject({ rows: 4,objects: 2 });
    const unguarded = new DatabaseSync(join(cliRestored,"app.sqlite"));
    try { unguarded.exec("DROP TRIGGER app_records_account_fence_insert"); }
    finally { unguarded.close(); }
    await expect(verifyRehearsedAccountBundle(output,cliRestored)).rejects.toThrow("fence guards differ");
    const extra = new DatabaseSync(join(restored,"app.sqlite"));
    try { extra.prepare("INSERT INTO app_records VALUES('foreign',?,?,'Foreign','No',1,'now','now')")
      .run(bob.tenant,bob.subject); }
    finally { extra.close(); }
    await expect(verifyRehearsedAccountBundle(output,restored)).rejects.toThrow("foreign application rows");
    const cleanup = new DatabaseSync(join(restored,"app.sqlite"));
    try { cleanup.prepare("DELETE FROM app_records WHERE id='foreign'").run(); }
    finally { cleanup.close(); }
    const restoredPath = join(restored,"uploads",uploadObjectKey(alice,id));
    writeFileSync(restoredPath,Buffer.from("altered bytes"));
    await expect(verifyRehearsedAccountBundle(output,restored)).rejects.toThrow("object bytes differ");
    writeFileSync(restoredPath,bytes);
    await expect(verifyRehearsedAccountBundle(output,restored)).resolves.toMatchObject({ rows: 4,objects: 2 });
    await expect(rehearseAccountBundle(output,restored)).rejects.toThrow();
    await expect(rehearseAccountBundle(output,join(output,"nested"))).rejects.toThrow("outside the bundle");
    await expect(exportAccountBundle("sqlite","local",alice,output,env)).rejects.toThrow();
    const offline = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/export-account-bundle.ts",
      "--verify",output],{ cwd: process.cwd(),encoding: "utf8" });
    expect(offline.status).toBe(0);
    expect(JSON.parse(offline.stdout)).toMatchObject({ rows: 4,objects: 2 });
    const archive = join(output,"objects.ndjson");
    writeFileSync(archive,readFileSync(archive,"utf8").replace(orphan,randomUUID()),{ mode: 0o600 });
    await expect(verifyAccountBundle(output)).rejects.toThrow("hashes or sizes differ");
    await expect(verifyRehearsedAccountBundle(output,restored)).rejects.toThrow("hashes or sizes differ");
    chmodSync(archive,0o644);
    await expect(verifyAccountBundle(output)).rejects.toThrow("unsafe archive");

    setSqliteAccountFence(path,bob);
    const failed = join(dir,"failed-bundle");
    await expect(exportAccountBundle("sqlite","local",bob,failed,env)).rejects.toThrow("differs from its catalog");
    expect(readdirSync(dir)).not.toContain("failed-bundle");
    await objects.delete(bob,foreignId);
    await expect(exportAccountBundle("sqlite","local",bob,failed,env)).rejects.toThrow("missing bytes");
    expect(readdirSync(dir)).not.toContain("failed-bundle");
    const argv = ["node_modules/tsx/dist/cli.mjs","scripts/export-account-bundle.ts","--metadata","sqlite",
      "--output",join(dir,"missing-stop")];
    const cli = spawnSync(process.execPath,argv,{ cwd: process.cwd(),encoding: "utf8",
      env: { ...process.env,...env,UPLOAD_STORAGE_PROVIDER: "local",ACCOUNT_AUDIT_TENANT: alice.tenant,
        ACCOUNT_AUDIT_SUBJECT: alice.subject } });
    expect(cli.status).toBe(2);
    expect(readdirSync(dir)).not.toContain("missing-stop");
  } finally { rmSync(dir,{ recursive: true,force: true }); }
},30_000);

it("bundles fenced Convex rows with an empty private object namespace",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-convex-bundle-"));
  const root = join(dir,"objects"),output = join(dir,"bundle"),secret = "test-convex-bundle-secret-".repeat(2);
  const backend = convexTest(schema,modules);
  const request: typeof fetch = (url,init) => backend.fetch(new URL(url instanceof Request ? url.url : url).pathname,init);
  vi.stubEnv("CONVEX_AUDIT_SECRET",secret);
  vi.stubEnv("CONVEX_BACKEND_SECRET","test-application-secret-".repeat(2));
  try {
    mkdirSync(root,{ mode: 0o700 });
    await backend.mutation(internal.records.create,{ ...alice,id: randomUUID(),title: "Alice",content: "private Convex content" });
    await setConvexAccountFence("https://test.convex.site",secret,alice,request);
    expect(await exportAccountBundle("convex","local",alice,output,
      { CONVEX_SITE_URL: "https://test.convex.site",CONVEX_AUDIT_SECRET: secret,UPLOAD_LOCAL_ROOT: root },request))
      .toMatchObject({ metadataProvider: "convex",objectProvider: "local",rows: 1,objects: 0,
        catalog: { catalogRows: 0,activeRows: 0,objectOrphans: 0,transitionalWithoutBytes: 0 } });
    expect(await verifyAccountBundle(output)).toMatchObject({ metadataProvider: "convex",rows: 1,objects: 0 });
  } finally { vi.unstubAllEnvs();rmSync(dir,{ recursive: true,force: true }); }
});
