import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
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
