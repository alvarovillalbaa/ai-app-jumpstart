import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { uploadCatalogContract } from "../contracts/upload-catalog";

uploadCatalogContract("SQLite", async () => sqliteUploadCatalog(":memory:"));

it("serializes quota admission across independent SQLite connections", async () => {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-upload-catalog-")),path = join(root,"app.sqlite");
  const first = sqliteUploadCatalog(path),second = sqliteUploadCatalog(path);
  const owner = { tenant: randomUUID(),subject: "alice" };
  const row = () => ({ id: randomUUID(),name: "note.txt",mediaType: "text/plain" as const,size: 6,
    sha256: "a".repeat(64),createdAt: Date.now() });
  try {
    const results = await Promise.all([first.reserve(owner,row(),{ maxBytes: 6,maxFiles: 1 }),second.reserve(owner,row(),{ maxBytes: 6,maxFiles: 1 })]);
    expect(results.toSorted()).toEqual(["quota","reserved"]);
    expect(await second.usage(owner)).toEqual({ files: 1,bytes: 6 });
  } finally { await first.close();await second.close();await rm(root,{ recursive: true,force: true }); }
});

it("upgrades the legacy SQLite state constraint and retains decisions across restarts",async () => {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-upload-upgrade-")),path = join(root,"app.sqlite");
  const owner = { tenant: "legacy",subject: "alice" },id = randomUUID(),deleted = randomUUID();
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE app_uploads(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,subject TEXT NOT NULL,name TEXT NOT NULL,
    media_type TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','quarantined','deleting','deleted')))`);
  for (const [key,state] of [[id,"quarantined"],[deleted,"deleted"]]) legacy.prepare("INSERT INTO app_uploads VALUES(?,?,?,?,?,?,?,?,?)")
    .run(key,owner.tenant,owner.subject,"legacy.txt","text/plain",6,"a".repeat(64),1000,state);
  legacy.close();
  let catalog = sqliteUploadCatalog(path);
  try {
    expect(await catalog.get(owner,id)).toMatchObject({ name: "legacy.txt",state: "quarantined" });
    expect(await catalog.get(owner,deleted)).toMatchObject({ state: "deleted" });
    const decision = { status: "clean" as const,sha256: "a".repeat(64),checkedAt: 2000,policyVersion: 1 as const };
    expect(await catalog.recordScan(owner,id,decision)).toBe(true);
    await catalog.close();catalog = sqliteUploadCatalog(path);
    expect(await catalog.get(owner,id)).toMatchObject({ state: "clean",scan: decision });
    const rejected = { ...decision,status: "rejected" as const,reason: "malware" as const,checkedAt: 3000 };
    expect(await catalog.recordScan(owner,id,rejected)).toBe(true);
    await catalog.close();catalog = sqliteUploadCatalog(path);
    expect(await catalog.recordScan(owner,id,{ ...decision,checkedAt: 4000 })).toBe(false);
    expect(await catalog.get(owner,id)).toMatchObject({ state: "rejected",scan: rejected });
    expect(await catalog.usage(owner)).toEqual({ files: 1,bytes: 6 });
  } finally { await catalog.close();await rm(root,{ recursive: true,force: true }); }
});
