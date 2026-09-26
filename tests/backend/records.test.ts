import { SqliteRepository } from "../../lib/data/sqlite";
import { recordContract } from "../contracts/records";
import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
recordContract("SQLite", async () => new SqliteRepository(":memory:"));

it("preserves records after the local repository closes and reopens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jumpstart-storage-"));
  const path = join(directory, "app.sqlite"), owner = { tenant: "org", subject: "user" };
  const first = new SqliteRepository(path);
  try {
    const created = await first.create(owner, { title: "Durable", content: "Survives restart" });
    await first.close();
    const second = new SqliteRepository(path);
    try { expect(await second.get(owner, created.id)).toEqual(created); }
    finally { await second.close(); }
  } finally { await rm(directory, { recursive: true }); }
});

it("retains keyed creation and its deletion fence across repository restarts",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-receipt-"));
  const path = join(directory,"app.sqlite"),owner = { tenant: "org",subject: "user" },key = randomUUID(),input = { title: "Durable",content: "Private" };
  let repo = new SqliteRepository(path);
  try {
    const original = await repo.createOnce(owner,key,input);
    if (original.status !== "created") throw new Error("Initial creation failed");
    await repo.close();repo = new SqliteRepository(path);
    expect(await repo.createOnce(owner,key,input)).toEqual({ ...original,status: "existing" });
    await repo.delete(owner,original.record.id,1);
    await repo.close();repo = new SqliteRepository(path);
    expect(await repo.createOnce(owner,key,input)).toEqual({ status: "deleted" });
    expect(await repo.getCreateReceipt(owner,key)).toEqual({ id: original.record.id,createdAt: original.record.createdAt });
  } finally { await repo.close();await rm(directory,{ recursive: true }); }
});
