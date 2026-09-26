import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PrivateUploadObjects } from "../../lib/uploads/contract";

/** Reuse unchanged for each private object-storage adapter. */
export function uploadObjectContract(name: string, factory: () => Promise<{ store: PrivateUploadObjects; close: () => Promise<void> }>) {
  describe(`Private upload objects: ${name}`, () => {
    const owner = { tenant: "tenant/private",subject: "alice@example.test" };
    const other = { tenant: "tenant/private",subject: "bob@example.test" };
    const otherTenant = { tenant: "other tenant",subject: owner.subject };
    let store: PrivateUploadObjects,close: () => Promise<void>;
    beforeEach(async () => { ({ store,close } = await factory()); });
    afterEach(async () => { await close(); });

    it("isolates owners, refuses sequential replacement and deletes only the owner's object", async () => {
      const id = randomUUID();
      await store.put(owner,id,new TextEncoder().encode("first"));
      expect(new TextDecoder().decode((await store.get(owner,id))!)).toBe("first");
      for (const stranger of [other,otherTenant]) {
        expect(await store.get(stranger,id)).toBeNull();
        expect(await store.delete(stranger,id)).toBe(false);
      }
      await expect(store.put(owner,id,new TextEncoder().encode("replacement"))).rejects.toBeDefined();
      expect(new TextDecoder().decode((await store.get(owner,id))!)).toBe("first");
      expect(await store.delete(owner,id)).toBe(true);
      expect(await store.get(owner,id)).toBeNull();
      expect(await store.delete(owner,id)).toBe(false);
    });

  });
}
