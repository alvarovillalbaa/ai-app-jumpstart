import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dayOf, type Admission, type BudgetStore } from "../../lib/budgets/contract";

export function budgetContract(name: string, factory: () => Promise<BudgetStore>) {
  describe(`Budget contract: ${name}`, () => {
    let store: BudgetStore, input: Admission;
    beforeEach(async () => {
      store = await factory();
      input = { tenant: randomUUID(), subject: "alice", operationId: randomUUID(), requestHash: "a".repeat(64), estimateMicros: 60,
        policy: { id: "policy-1", dailyMicros: 100, maxActive: 10, maxPerMinute: 10 }, now: Date.UTC(2026,8,22,12) };
    });
    afterEach(async () => { await store?.close(); });
    const owner = (value: Admission) => ({ tenant: value.tenant, subject: value.subject });
    const next = (value: Admission) => ({ ...value, operationId: randomUUID() });
    const view = (value: Admission) => store.snapshot({ ...owner(value), now: value.now });
    it("pages historical reservations by owner across equal timestamps and settlements", async () => {
      const entries = [
        { ...input,estimateMicros: 20,operationId: randomUUID() },
        { ...input,estimateMicros: 20,operationId: randomUUID() },
        { ...input,estimateMicros: 20,operationId: randomUUID(),now: input.now+1 },
      ];
      for (const entry of entries) expect((await store.reserve(entry)).status).toBe("reserved");
      const foreign = { ...input,subject: "bob",estimateMicros: 20,operationId: randomUUID() };
      expect((await store.reserve(foreign)).status).toBe("reserved");
      await store.settle({ ...owner(entries[0]),operationId: entries[0].operationId,actualMicros: 7 });
      const results: Awaited<ReturnType<BudgetStore["listLedger"]>>["items"] = [];
      let cursor: string | undefined;
      do {
        const page = await store.listLedger({ ...owner(input),limit: 1,...(cursor ? { cursor } : {}) });
        expect(page.items).toHaveLength(1);
        results.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(results.map(row => row.operationId)).toEqual(entries.toSorted((a,b) => a.now-b.now || a.operationId.localeCompare(b.operationId)).map(row => row.operationId));
      expect(results.find(row => row.operationId === entries[0].operationId)).toMatchObject({ status: "settled",actualMicros: 7 });
      expect(JSON.stringify(results)).not.toContain(input.requestHash);
      expect((await store.listLedger({ ...owner(input),subject: "bob" })).items.map(row => row.operationId)).toEqual([foreign.operationId]);
      await expect(store.listLedger({ ...owner(input),limit: 101 })).rejects.toBeDefined();
      await expect(store.listLedger({ ...owner(input),cursor: "invalid" })).rejects.toBeDefined();
    });
    it("pages outstanding reservations oldest first across owners without exposing request hashes", async () => {
      const entries = [
        { ...input,estimateMicros: 20,operationId: randomUUID() },
        { ...input,estimateMicros: 20,operationId: randomUUID(),subject: "bob" },
        { ...input,estimateMicros: 20,operationId: randomUUID(),now: input.now+1 },
      ];
      for (const entry of entries) expect((await store.reserve(entry)).status).toBe("reserved");
      const expected: string[] = entries.toSorted((a,b) => a.now-b.now || a.operationId.localeCompare(b.operationId)).map(entry => entry.operationId);
      const ids: string[] = [], seen = new Set<string>(); let cursor: string | undefined;
      do {
        const page = await store.listOutstanding({ limit: 1,...(cursor ? { cursor } : {}) });
        // Other contract files share this disposable provider and may settle
        // their rows between pages of this deliberately nontransactional scan.
        if (page.items.length) {
          expect(page.items).toHaveLength(1);
          expect(Object.keys(page.items[0]).toSorted()).toEqual(["createdAt","estimateMicros","operationId","policyId","subject","tenant"]);
          expect(seen.has(page.items[0].operationId)).toBe(false);
          seen.add(page.items[0].operationId);
          if (page.items[0].tenant === input.tenant && expected.includes(page.items[0].operationId)) ids.push(page.items[0].operationId);
        } else expect(page.nextCursor).toBeNull();
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      expect(ids).toEqual(expected);
      await store.settle({ ...owner(entries[0]),operationId: entries[0].operationId,actualMicros: 0 });
      const remaining = (await store.listOutstanding({ limit: 100 })).items.map(row => row.operationId);
      expect(remaining.filter(id => expected.includes(id))).toEqual(expected.filter(id => id !== entries[0].operationId));
      await expect(store.listOutstanding({ limit: 101 })).rejects.toBeDefined();
      await expect(store.listOutstanding({ limit: 1,cursor: "invalid" })).rejects.toBeDefined();
    });
    it("looks up only the owner's reservation without exposing an absent operation", async () => {
      const query = { ...owner(input),operationId: input.operationId };
      expect(await store.getReservation(query)).toBeNull();
      await store.reserve(input);
      expect(await store.getReservation(query)).toEqual({ requestHash: input.requestHash,status: "reserved" });
      expect(await store.getReservation({ ...query,subject: "bob" })).toBeNull();
      expect(await store.getReservation({ ...query,tenant: randomUUID() })).toBeNull();
      await store.settle({ ...owner(input),operationId: input.operationId,actualMicros: 0 });
      expect(await store.getReservation(query)).toEqual({ requestHash: input.requestHash,status: "settled" });
    });
    it("limits model attempts atomically, isolates owners, and blocks reuse after settlement", async () => {
      await store.reserve(input);
      const base = { ...owner(input), operationId: input.operationId, maxAttempts: 2 };
      const attempts = ["b","c","d","e"].map(c => ({ ...base, attemptId: c.repeat(64) }));
      const results = await Promise.all(attempts.map(a => store.claimAttempt(a)));
      expect(results.filter(Boolean)).toHaveLength(2);
      expect(await store.attemptCount({ ...owner(input), operationId: input.operationId })).toBe(2);
      const accepted = attempts[results.indexOf(true)];
      expect(await store.claimAttempt(accepted)).toBe(true);
      expect(await store.claimAttempt({ ...accepted, subject: "bob" })).toBe(false);
      expect(await store.attemptCount({ ...owner(input), subject: "bob", operationId: input.operationId })).toBe(0);
      await store.settle({ ...owner(input), operationId: input.operationId, actualMicros: null });
      expect(await store.claimAttempt(accepted)).toBe(false);
    });
    it("atomically reserves daily capacity under concurrent distinct requests", async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => store.reserve(next(input))));
      expect(results.filter(r => r.status === "reserved")).toHaveLength(1);
      expect(results.filter(r => r.status === "denied" && r.reason === "daily_limit")).toHaveLength(5);
      expect(await view(input)).toMatchObject({ reservedMicros: 60, chargedMicros: 0, active: 1, recent: 1 });
    });
    it("charges one idempotent operation and rejects changed input or owner", async () => {
      const results = await Promise.all(Array.from({ length: 4 }, () => store.reserve(input)));
      expect(results.filter(r => r.status === "reserved" && r.created)).toHaveLength(1);
      expect(results.every(r => r.status === "reserved")).toBe(true);
      for (const change of [{ subject: "bob" }, { tenant: randomUUID() }, { requestHash: "b".repeat(64) }, { estimateMicros: 1 }, { policy: { ...input.policy, id: "changed" } }]) {
        expect(await store.reserve({ ...input, ...change })).toEqual({ status: "denied", reason: "conflict" });
      }
      expect(await store.settle({ ...owner(input), subject: "bob", operationId: input.operationId, actualMicros: 0 })).toBe(false);
      expect(await view({ ...input, subject: "bob" })).toMatchObject({ active: 0, reservedMicros: 0 });
    });
    it("enforces active limits independently of daily capacity and releases only on settlement", async () => {
      input.policy = { ...input.policy, dailyMicros: 10000, maxActive: 1 };
      await store.reserve(input);
      expect(await store.reserve(next(input))).toEqual({ status: "denied", reason: "active_limit" });
      expect(await store.settle({ ...owner(input), operationId: input.operationId, actualMicros: 20 })).toBe(true);
      expect(await store.reserve(next(input))).toEqual({ status: "reserved", created: true });
      expect(await view(input)).toMatchObject({ chargedMicros: 20, reservedMicros: 60, active: 1 });
    });
    it("limits accepted requests in a rolling minute even after they settle", async () => {
      input.policy = { ...input.policy, dailyMicros: 10000, maxPerMinute: 1 };
      await store.reserve(input); await store.settle({ ...owner(input), operationId: input.operationId, actualMicros: 0 });
      expect(await store.reserve({ ...next(input), now: input.now+59999 })).toEqual({ status: "denied", reason: "rate_limit" });
      expect(await store.reserve({ ...next(input), now: input.now+60000 })).toEqual({ status: "reserved", created: true });
    });
    it("settles unknown costs conservatively and prevents duplicate or conflicting refunds", async () => {
      await store.reserve(input);
      const settle = { ...owner(input), operationId: input.operationId, actualMicros: null };
      expect(await Promise.all([store.settle(settle),store.settle(settle)])).toEqual([true,true]);
      expect(await store.settle({ ...settle, actualMicros: 0 })).toBe(false);
      expect(await store.reserve(input)).toEqual({ status: "settled", created: false });
      expect(await view(input)).toMatchObject({ reservedMicros: 0, chargedMicros: 60, unknownCosts: 1, active: 0 });
      expect(await store.reserve(next(input))).toEqual({ status: "denied", reason: "daily_limit" });
    });
    it("corrects a settled cost with an immutable owner-scoped audit and compare-and-swap", async () => {
      const key = { ...owner(input),operationId: input.operationId };
      const correction = { ...key,correctionId: randomUUID(),expectedActualMicros: null,correctedActualMicros: 25,
        actor: "operator-1",reason: "Provider invoice confirms final usage",evidenceRef: "invoice:test-1" };
      expect(await store.inspectReservation(key)).toBeNull();
      expect(await store.correctSettlement(correction)).toBe("not_found");
      await store.reserve(input);
      expect(await store.correctSettlement(correction)).toBe("conflict");
      await store.settle({ ...key,actualMicros: null });
      expect(await store.inspectReservation(key)).toMatchObject({ status: "settled",estimateMicros: 60,actualMicros: null });
      expect(await store.correctSettlement({ ...correction,subject: "bob" })).toBe("not_found");
      expect((await Promise.all([store.correctSettlement(correction),store.correctSettlement(correction)])).toSorted())
        .toEqual(["already_applied","applied"].toSorted());
      expect(await store.correctSettlement(correction)).toBe("already_applied");
      expect(await store.correctSettlement({ ...correction,reason: "Changed evidence after the fact" })).toBe("conflict");
      expect(await view(input)).toMatchObject({ chargedMicros: 25,unknownCosts: 0,active: 0 });
      expect(await store.inspectReservation(key)).toMatchObject({ actualMicros: 25 });
      expect(await store.listCorrections({ ...key,subject: "bob" })).toEqual([]);
      expect(await store.listCorrections(key)).toEqual([expect.objectContaining({ correctionId: correction.correctionId,
        previousActualMicros: null,correctedActualMicros: 25,actor: correction.actor,evidenceRef: correction.evidenceRef,
        at: expect.any(Number) })]);
      const second = { ...correction,correctionId: randomUUID(),expectedActualMicros: 25,correctedActualMicros: 45 };
      expect(await store.correctSettlement({ ...second,expectedActualMicros: null })).toBe("conflict");
      expect(await store.correctSettlement(second)).toBe("applied");
      expect(await view(input)).toMatchObject({ chargedMicros: 45,unknownCosts: 0 });
      expect((await store.listCorrections(key)).map(row => row.correctionId).toSorted()).toEqual([second.correctionId,correction.correctionId].toSorted());
      expect(await store.settle({ ...key,actualMicros: null })).toBe(false);
    });
    it("records overages rather than clipping cost to an estimate", async () => {
      await store.reserve(input);
      expect(await store.settle({ ...owner(input), operationId: input.operationId, actualMicros: 150 })).toBe(true);
      expect(await view(input)).toMatchObject({ chargedMicros: 150, reservedMicros: 0, unknownCosts: 0 });
      expect(await store.reserve({ ...next(input), estimateMicros: 1 })).toEqual({ status: "denied", reason: "daily_limit" });
    });
    it("keeps outstanding runs across midnight and assigns settlement to the admission day", async () => {
      input.policy.maxActive = 1; await store.reserve(input);
      const tomorrow = { ...next(input), now: input.now+86400000 };
      expect(await view(tomorrow)).toMatchObject({ day: dayOf(tomorrow.now), reservedMicros: 0, chargedMicros: 0, active: 1 });
      expect(await store.reserve(tomorrow)).toEqual({ status: "denied", reason: "active_limit" });
      await store.settle({ ...owner(input), operationId: input.operationId, actualMicros: 70 });
      expect(await view(input)).toMatchObject({ chargedMicros: 70 });
      expect(await store.reserve(tomorrow)).toEqual({ status: "reserved", created: true });
    });
    it("rejects invalid amounts, policies and missing explicit usage state", async () => {
      await expect(store.reserve({ ...input, estimateMicros: 0 })).rejects.toBeDefined();
      await expect(store.reserve({ ...input, policy: { ...input.policy, maxActive: 0 } })).rejects.toBeDefined();
      await expect(store.settle({ ...owner(input), operationId: input.operationId, actualMicros: -1 })).rejects.toBeDefined();
      expect(await store.settle({ ...owner(input), operationId: input.operationId, actualMicros: null })).toBe(false);
      expect(await view(input)).toMatchObject({ active: 0, recent: 0 });
    });
  });
}
