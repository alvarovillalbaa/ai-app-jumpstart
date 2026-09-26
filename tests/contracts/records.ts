import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Owner,RecordRepository } from "../../lib/data/contract";
import { RecordService } from "../../lib/data/service";

/** Run this unchanged against each adapter, including disposable remote databases. */
export function recordContract(name: string, factory: () => Promise<RecordRepository>) {
  describe(`Record contract: ${name}`, () => {
    let repo: RecordRepository, a: RecordService, b: RecordService, otherOrg: RecordService;
    let owner: Owner;
    const cleanup: { service: RecordService; id: string }[] = [];
    beforeEach(async () => {
      repo = await factory();
      const tenant = randomUUID();
      owner = { tenant,subject: "alice" };
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
    it("creates exactly once under concurrent keyed retries, including uppercase keys",async () => {
      const key = randomUUID(),input = { title: "  One draft  ",content: "Same input" };
      const results = await Promise.all(Array.from({ length: 8 },(_,i) => a.createOnce(i % 2 ? key.toUpperCase() : key,input)));
      expect(results.filter(result => result.status === "created")).toHaveLength(1);
      expect(results.filter(result => result.status === "existing")).toHaveLength(7);
      const original = results[0].record;
      cleanup.push({ service: a,id: original.id });
      for (const result of results) expect(result.record).toEqual(original);
      expect(original.title).toBe("One draft");
      expect((await a.list()).items).toHaveLength(1);
    });
    it("rejects concurrent changed input for one key and retains only the winning record",async () => {
      const key = randomUUID();
      const results = await Promise.allSettled(["First","Second"].map(title => a.createOnce(key,{ title,content: "Different input" })));
      const success = results.filter(result => result.status === "fulfilled");
      expect(success).toHaveLength(1);
      expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409,code: "creation_conflict" } });
      if (success[0].status !== "fulfilled") throw new Error("No winning creation");
      cleanup.push({ service: a,id: success[0].value.record.id });
      expect((await a.list()).items).toHaveLength(1);
    });
    it("scopes keys and receipt reads to both user and organization",async () => {
      const key = randomUUID(),input = { title: "Scoped",content: "Private" };
      const original = await a.createOnce(key,input);
      cleanup.push({ service: a,id: original.record.id });
      for (const stranger of [b,otherOrg]) {
        await expect(stranger.creation(key)).rejects.toMatchObject({ status: 404 });
        const own = await stranger.createOnce(key,input);
        cleanup.push({ service: stranger,id: own.record.id });
        expect(own.status).toBe("created");expect(own.record.id).not.toBe(original.record.id);
        expect(await stranger.creation(key)).toMatchObject({ status: "created",record: { id: own.record.id } });
      }
    });
    it("replays original input without exposing later edits to write-only credentials",async () => {
      const key = randomUUID(),input = { title: "Original",content: "Initial content" };
      const original = await a.createOnce(key,input);
      cleanup.push({ service: a,id: original.record.id });
      const edited = await a.update(original.record.id,{ title: "Private edit",content: "Later secret",revision: 1 });
      const writer = new RecordService(repo,{ ...owner,scopes: ["records:write"] });
      expect(await writer.createOnce(key,input)).toEqual({ status: "existing",record: original.record });
      await expect(writer.creation(key)).rejects.toMatchObject({ status: 403 });
      expect(await a.creation(key)).toEqual({ status: "created",record: edited });
      await expect(a.createOnce(key,{ title: "Changed",content: input.content })).rejects.toMatchObject({ status: 409 });
      const reader = new RecordService(repo,{ ...owner,scopes: ["records:read"] });
      await expect(reader.createOnce(randomUUID(),input)).rejects.toMatchObject({ status: 403 });
      await expect(a.createOnce("not-a-uuid",input)).rejects.toThrow();
      await expect(a.createOnce(randomUUID(),{ ...input,tenant: "forged" })).rejects.toThrow();
    });
    it("retains a deletion fence so a delayed retry cannot resurrect the record",async () => {
      const key = randomUUID(),input = { title: "Deleted",content: "Remove this" };
      const original = await a.createOnce(key,input);
      await a.delete(original.record.id,1);
      expect(await a.creation(key)).toEqual({ status: "deleted",id: original.record.id });
      await expect(a.createOnce(key,input)).rejects.toMatchObject({ status: 410,code: "record_deleted" });
      expect((await a.list()).items).toEqual([]);
    });
  });
}
