import { SqliteRepository } from "../../lib/data/sqlite";
import { recordContract } from "../contracts/records";
import { expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
