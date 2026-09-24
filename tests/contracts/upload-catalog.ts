import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UploadCatalog, UploadReservation } from "../../lib/uploads/catalog-contract";

export function uploadCatalogContract(name: string, factory: () => Promise<UploadCatalog>) {
  describe(`Upload catalog: ${name}`, () => {
    let catalog: UploadCatalog;
    let owner: { tenant: string;subject: string };
    const quota = { maxBytes: 10, maxFiles: 2 };
    const input = (size = 6): UploadReservation => ({ id: randomUUID(),name: "private.txt",mediaType: "text/plain",size,
      sha256: "a".repeat(64),createdAt: Date.now() });
    beforeEach(async () => { catalog = await factory();owner = { tenant: randomUUID(),subject: "alice" }; });
    afterEach(async () => { await catalog?.close(); });

    it("reserves atomically within owner byte and file quotas", async () => {
      const entries = [input(6),input(6),input(6)];
      const results = await Promise.all(entries.map(entry => catalog.reserve(owner,entry,quota)));
      expect(results.filter(result => result === "reserved")).toHaveLength(1);
      expect(results.filter(result => result === "quota")).toHaveLength(2);
      expect(await catalog.usage(owner)).toEqual({ files: 1,bytes: 6 });
      expect(await catalog.reserve(owner,input(4),quota)).toBe("reserved");
      expect(await catalog.usage(owner)).toEqual({ files: 2,bytes: 10 });
      expect(await catalog.reserve(owner,input(1),quota)).toBe("quota");
      expect(await catalog.reserve({ ...owner,subject: "bob" },input(6),quota)).toBe("reserved");
    });

    it("keeps idempotency and owner isolation without leaking another owner's metadata", async () => {
      const row = input(),other = { ...owner,subject: "bob" };
      expect(await catalog.reserve(owner,row,quota)).toBe("reserved");
      expect(await catalog.reserve(owner,{ ...row,createdAt: row.createdAt+1 },quota)).toBe("existing");
      expect(await catalog.reserve(owner,{ ...row,sha256: "b".repeat(64) },quota)).toBe("conflict");
      expect(await catalog.reserve(other,row,quota)).toBe("conflict");
      expect(await catalog.get(other,row.id)).toBeNull();
      expect(await catalog.list(other)).toEqual([]);
      expect(await catalog.list(owner)).toEqual([{ ...row,state: "pending" }]);
      expect(await catalog.markStored(other,row.id)).toBe(false);
      expect(await catalog.beginDelete(other,row.id)).toBe(false);
      expect(await catalog.finishDelete(other,row.id)).toBe(false);
      expect(await catalog.usage(other)).toEqual({ files: 0,bytes: 0 });
      expect(await catalog.get(owner,row.id)).toEqual({ ...row,state: "pending" });
    });

    it("holds quota through quarantine and deletion until blob removal is confirmed", async () => {
      const row = input(),second = input();
      expect(await catalog.reserve(owner,row,{ maxBytes: 6,maxFiles: 1 })).toBe("reserved");
      expect(await catalog.markStored(owner,row.id)).toBe(true);
      expect(await catalog.markStored(owner,row.id)).toBe(true);
      expect(await catalog.get(owner,row.id)).toMatchObject({ state: "quarantined" });
      expect(await catalog.beginDelete(owner,row.id)).toBe(true);
      expect(await catalog.beginDelete(owner,row.id)).toBe(true);
      expect(await catalog.get(owner,row.id)).toMatchObject({ state: "deleting" });
      expect(await catalog.reserve(owner,second,{ maxBytes: 6,maxFiles: 1 })).toBe("quota");
      expect(await catalog.finishDelete(owner,row.id)).toBe(true);
      expect(await catalog.finishDelete(owner,row.id)).toBe(true);
      expect(await catalog.markStored(owner,row.id)).toBe(false);
      expect(await catalog.get(owner,row.id)).toMatchObject({ state: "deleted" });
      expect(await catalog.list(owner)).toEqual([]);
      expect(await catalog.usage(owner)).toEqual({ files: 0,bytes: 0 });
      expect(await catalog.reserve(owner,second,{ maxBytes: 6,maxFiles: 1 })).toBe("reserved");
      expect(await catalog.reserve(owner,row,{ maxBytes: 6,maxFiles: 1 })).toBe("existing");
      expect(await catalog.beginDelete(owner,randomUUID())).toBe(false);
    });

    it("rejects invalid metadata and quota values before writing", async () => {
      await expect(catalog.reserve(owner,{ ...input(),name: "../escape.txt" },quota)).rejects.toBeDefined();
      await expect(catalog.reserve(owner,input(),{ maxBytes: 0,maxFiles: 1 })).rejects.toBeDefined();
      expect(await catalog.usage(owner)).toEqual({ files: 0,bytes: 0 });
    });
  });
}
