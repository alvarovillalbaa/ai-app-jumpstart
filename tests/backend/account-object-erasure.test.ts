import { createHash,randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { SqliteRepository } from "../../lib/data/sqlite";
import { sqlitePreferenceStore } from "../../lib/preferences/sqlite";
import { sqliteRequestLimitStore } from "../../lib/request-limits/sqlite";
import { uploadObjectKey } from "../../lib/uploads/contract";
import { localUploadObjects } from "../../lib/uploads/local";
import { listLocalOwnerObjectIds,readLocalOwnerObject } from "../../lib/uploads/object-export";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { eraseAccountObjects,eraseSelectedAccountObjects } from "../../scripts/erase-account-objects";
import { eraseAccountRows } from "../../scripts/erase-account-rows";
import { exportAccountBundle,verifyAccountBundle } from "../../scripts/export-account-bundle";
import { setSqliteAccountFence } from "../../scripts/fence-account-writes";

const owner = { tenant: "object-erasure-tenant",subject: "alice" };
const foreign = { ...owner,subject: "bob" };

it("requires a fenced verified bundle, checks exact bytes, and resumes owner-only object deletion",async () => {
  const dir = mkdtempSync(join(tmpdir(),"jumpstart-object-erasure-"));
  const path = join(dir,"app.sqlite"),root = join(dir,"objects"),bundle = join(dir,"bundle");
  const activeId = randomUUID(),orphanId = randomUUID(),foreignId = randomUUID();
  const activeBytes = Buffer.from("Alice private bytes"),orphanBytes = Buffer.from("orphan bytes");
  try {
    const stores = [new SqliteRepository(path),sqliteAccessStore(path),sqliteBudgetStore(path),
      sqliteUploadCatalog(path),sqlitePreferenceStore(path),sqliteRequestLimitStore(path)];
    for (const store of stores) await store.close();
    const db = new DatabaseSync(path);
    try {
      db.prepare("INSERT INTO app_records VALUES('alice-record',?,?,'Alice','private',1,'now','now')")
        .run(owner.tenant,owner.subject);
      db.prepare("INSERT INTO app_records VALUES('bob-record',?,?,'Bob','foreign',1,'now','now')")
        .run(foreign.tenant,foreign.subject);
      db.prepare("INSERT INTO app_uploads VALUES(?,?,?,?,?,?,?,?,?)").run(activeId,owner.tenant,owner.subject,
        "alice.txt","text/plain",activeBytes.length,createHash("sha256").update(activeBytes).digest("hex"),1,"quarantined");
    } finally { db.close(); }
    const objects = localUploadObjects(root);
    await objects.put(owner,activeId,activeBytes);
    await objects.put(owner,orphanId,orphanBytes);
    await objects.put(foreign,foreignId,Buffer.from("Bob private bytes"));
    setSqliteAccountFence(path,owner);
    const env = { ACCOUNT_AUDIT_SQLITE_PATH: path,UPLOAD_LOCAL_ROOT: root };
    await exportAccountBundle("sqlite","local",owner,bundle,env);
    await expect(eraseSelectedAccountObjects("local",owner,bundle,env)).resolves.toMatchObject({
      objects: 2,remainingBefore: 2,deleted: 0,status: "private-object-erasure-planned" });
    await expect(eraseSelectedAccountObjects("local",foreign,bundle,env,true)).rejects.toThrow("selected account owner");
    const source = { list: () => listLocalOwnerObjectIds(root,owner),
      get: (id: string) => readLocalOwnerObject(root,owner,id),delete: (id: string) => objects.delete(owner,id) };
    await expect(eraseAccountObjects(source,"supabase",owner,bundle,env,true)).rejects.toThrow("object provider");
    const activePath = join(root,uploadObjectKey(owner,activeId));
    writeFileSync(activePath,Buffer.from("X".repeat(activeBytes.length)));
    await expect(eraseSelectedAccountObjects("local",owner,bundle,env,true)).rejects.toThrow("bytes differ");
    expect(await objects.get(owner,orphanId)).toEqual(orphanBytes);
    writeFileSync(activePath,activeBytes);
    const unarchivedId = randomUUID();
    await objects.put(owner,unarchivedId,Buffer.from("late"));
    await expect(eraseSelectedAccountObjects("local",owner,bundle,env,true)).rejects.toThrow("unarchived object");
    await objects.delete(owner,unarchivedId);
    let deleteCalls = 0;
    await expect(eraseAccountObjects({ ...source,async delete(id) {
      if (++deleteCalls === 2) throw new Error("interrupted remote deletion");
      return source.delete(id);
    } },"local",owner,bundle,env,true)).rejects.toThrow("interrupted");
    expect(deleteCalls).toBe(2);
    expect(await verifyAccountBundle(bundle)).toMatchObject({ rows: 2,objects: 2 });
    const resumed = await eraseSelectedAccountObjects("local",owner,bundle,env,true);
    expect(resumed).toMatchObject({ objects: 2,remainingBefore: 1,deleted: 1,status: "private-objects-erased" });
    expect(await listLocalOwnerObjectIds(root,owner)).toEqual([]);
    expect(await objects.get(foreign,foreignId)).toEqual(Buffer.from("Bob private bytes"));
    await expect(eraseSelectedAccountObjects("local",owner,bundle,env,true)).resolves.toMatchObject({
      remainingBefore: 0,deleted: 0,status: "private-objects-erased" });
    await expect(eraseAccountRows("sqlite",owner,bundle,env,true)).resolves.toMatchObject({
      status: "application-rows-erased",rows: 2 });
    const final = new DatabaseSync(path);
    try {
      expect(final.prepare("SELECT COUNT(*) AS count FROM app_records WHERE subject='alice'").get()).toEqual({ count: 0 });
      expect(final.prepare("SELECT content FROM app_records WHERE subject='bob'").get()).toEqual({ content: "foreign" });
      expect(final.prepare("SELECT COUNT(*) AS count FROM app_account_fences WHERE tenant=? AND subject=?")
        .get(owner.tenant,owner.subject)).toEqual({ count: 1 });
    } finally { final.close(); }
    const cli = spawnSync(process.execPath,["node_modules/tsx/dist/cli.mjs","scripts/erase-account-objects.ts",
      "--source",bundle,"--stopped"],{ cwd: process.cwd(),encoding: "utf8",
      env: { ...process.env,...env,UPLOAD_STORAGE_PROVIDER: "local",ACCOUNT_AUDIT_TENANT: owner.tenant,
        ACCOUNT_AUDIT_SUBJECT: owner.subject } });
    expect(cli.status).toBe(2);
    expect(readFileSync(join(bundle,"manifest.json"),"utf8")).not.toContain(owner.subject);
  } finally { rmSync(dir,{ recursive: true,force: true }); }
},30_000);
