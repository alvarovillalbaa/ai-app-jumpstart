import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { RecordRepository } from "../../lib/data/contract";
import { RecordService } from "../../lib/data/service";

/** Run this unchanged against each adapter, including disposable remote databases. */
export function recordContract(name: string, factory: () => Promise<RecordRepository>) {
  describe(`Record contract: ${name}`, () => {
    let repo: RecordRepository, a: RecordService, b: RecordService, otherOrg: RecordService;
    const cleanup: { service: RecordService; id: string }[] = [];
    beforeEach(async () => {
      repo = await factory();
      const tenant = randomUUID();
      a = new RecordService(repo, { tenant, subject: "alice", scopes: ["records:read", "records:write"] });
      b = new RecordService(repo, { tenant, subject: "bob", scopes: ["records:read", "records:write"] });
      otherOrg = new RecordService(repo, { tenant: randomUUID(), subject: "alice", scopes: ["records:read", "records:write"] });
    });
    afterEach(async () => {
      for (const { service, id } of cleanup.splice(0)) {
        try { const row = await service.get(id); await service.delete(id, row.revision); }
        catch (error) { if (!(error instanceof Error && "status" in error && error.status === 404)) throw error; }
      }
      await repo?.close();
    });
    async function create(title = "Private record") {
      const row = await a.create({ title, content: "A private note" });
      cleanup.push({ service: a, id: row.id }); return row;
    }
    it("isolates reads and writes across users and organizations", async () => {
      const row = await create();
      for (const stranger of [b, otherOrg]) {
        expect((await stranger.list()).items).toEqual([]);
        await expect(stranger.get(row.id)).rejects.toMatchObject({ status: 404 });
        await expect(stranger.update(row.id, { title: "stolen", content: "", revision: 1 })).rejects.toMatchObject({ status: 409 });
        await expect(stranger.delete(row.id, 1)).rejects.toMatchObject({ status: 409 });
      }
      expect((await a.get(row.id)).title).toBe("Private record");
    });
    it("allows exactly one concurrent update at a revision", async () => {
      const row = await create();
      const results = await Promise.allSettled(["First", "Second"].map(title => a.update(row.id, { title, content: "", revision: 1 })));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
      await expect(a.delete(row.id, 1)).rejects.toMatchObject({ status: 409 });
      expect((await a.get(row.id)).revision).toBe(2);
    });
    it("paginates without repeats and does not disclose owner columns", async () => {
      await Promise.all([create("one"), create("two"), create("three")]);
      const first = await a.list({ limit: 2 });
      expect(first.items).toHaveLength(2); expect(first.nextCursor).toBeTruthy();
      const last = await a.list({ limit: 2, after: first.nextCursor });
      expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeNull();
      expect(new Set([...first.items, ...last.items].map(r => r.id)).size).toBe(3);
      expect(first.items[0]).not.toHaveProperty("subject");
    });
    it("rejects forged ownership, invalid input and missing scopes", async () => {
      await expect(a.create({ title: "", content: "" })).rejects.toThrow();
      await expect(a.create({ title: "test", content: "", tenant: "another" })).rejects.toThrow();
      await expect(a.list({ limit: 101 })).rejects.toThrow();
      const reader = new RecordService(repo, { tenant: "a", subject: "b", scopes: ["records:read"] });
      await expect(reader.create({ title: "test", content: "" })).rejects.toMatchObject({ status: 403 });
    });
    it("reports storage readiness", async () => { await expect(repo.health()).resolves.toBeUndefined(); });
  });
}
