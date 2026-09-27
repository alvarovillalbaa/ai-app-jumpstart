import { afterEach,beforeEach,describe,expect,it } from "vitest";
import { randomUUID } from "node:crypto";
import type { RequestLimitStore } from "../../lib/request-limits/contract";

export function requestLimitContract(name: string,factory: () => Promise<RequestLimitStore>) {
  describe(`Request limits: ${name}`,() => {
    let store: RequestLimitStore,owner: { tenant: string;subject: string };
    beforeEach(async () => { store = await factory();owner = { tenant: randomUUID(),subject: randomUUID() }; });
    afterEach(async () => store?.close());
    it("probes readiness without consuming owner capacity",async () => {
      await store.health();await store.health();expect(await store.claim(owner,2)).toMatchObject({ allowed: true,remaining: 1 });
    });
    it("admits at most the configured count per window under concurrent claims",async () => {
      const results = await Promise.all(Array.from({ length: 30 },() => store.claim(owner,7)));
      const buckets = new Set(results.map(row => row.resetAt));
      for (const bucket of buckets) {
        const admitted = results.filter(row => row.resetAt === bucket && row.allowed);
        expect(admitted.length).toBeLessThanOrEqual(7);
        expect(new Set(admitted.map(row => row.remaining)).size).toBe(admitted.length);
      }
      expect(results.some(row => row.allowed)).toBe(true);expect(results.some(row => !row.allowed)).toBe(true);
      for (const row of results) {
        expect(row.retryAfterSeconds).toEqual(row.allowed ? 0 : expect.any(Number));
        if (!row.allowed) { expect(row.remaining).toBe(0);expect(row.retryAfterSeconds).toBeGreaterThanOrEqual(1);expect(row.retryAfterSeconds).toBeLessThanOrEqual(60); }
      }
    });
    it("isolates both owner fields and preserves claims when a policy is lowered then raised",async () => {
      const first = await store.claim(owner,2);expect(first.allowed).toBe(true);
      const second = await store.claim(owner,2);expect(second.remaining).toBe(first.resetAt === second.resetAt ? 0 : 1);
      const lowered = await store.claim(owner,1);
      if (lowered.resetAt === second.resetAt) {
        expect(lowered.allowed).toBe(false);
        const raised = await store.claim(owner,3);
        if (raised.resetAt === second.resetAt) expect(raised).toMatchObject({ allowed: true,remaining: second.remaining });
      }
      for (const other of [{ ...owner,subject: "other" },{ ...owner,tenant: "other" }]) expect(await store.claim(other,2)).toMatchObject({ allowed: true,remaining: 1 });
    });
    it("rejects invalid limits and owner injection before consuming a slot",async () => {
      for (const limit of [0,-1,1.5,10001,NaN]) await expect(store.claim(owner,limit)).rejects.toBeDefined();
      await expect(store.claim({ ...owner,limit: 10000 } as never,2)).rejects.toBeDefined();
      expect(await store.claim(owner,2)).toMatchObject({ allowed: true,remaining: 1 });
    });
  });
}
