import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { AccessOwner, Reservation, SessionAccessStore } from "../../lib/agent-access/contract";
import type { ProjectionEntry } from "../../lib/agent-access/projection-contract";

/** Requires a disposable database: revoked bindings are intentionally retained. */
export function sessionAccessContract(name: string, factory: () => Promise<SessionAccessStore>) {
  describe(`Session access contract: ${name}`, () => {
    let store: SessionAccessStore, owner: AccessOwner, strangers: AccessOwner[], input: Reservation;
    let sessionNamespace: string;
    const sid = (name: string) => `${name}-${sessionNamespace}`;
    beforeEach(async () => {
      store = await factory();
      sessionNamespace = randomUUID();
      owner = { tenant: randomUUID(), subject: "alice" };
      strangers = [{ ...owner, subject: "bob" }, { tenant: randomUUID(), subject: owner.subject }];
      input = { ...owner, id: randomUUID(), operationId: randomUUID(), requestHash: randomBytes(32).toString("hex") };
    });
    afterEach(async () => { await store?.close(); });
    it("commits approved artifact calls once, isolates owners and denies writes after revocation",async () => {
      const draft = { title: "Private note",content: "Plain text content" };
      expect(await store.saveArtifact(owner,input.operationId,sid("artifact-session"),"call-1",draft)).toEqual({ status: "unavailable" });
      await store.reserve(input);
      expect(await store.saveArtifact(owner,input.operationId,sid("artifact-session"),"call-1",draft)).toEqual({ status: "unavailable" });
      await store.bind(owner,input.operationId,sid("artifact-session"));
      for (const stranger of strangers) expect(await store.saveArtifact(stranger,input.operationId,sid("artifact-session"),"call-1",draft)).toEqual({ status: "unavailable" });
      expect(await store.saveArtifact(owner,input.operationId,sid("other-session"),"call-1",draft)).toEqual({ status: "unavailable" });
      const outcomes = await Promise.all(Array.from({ length: 3 },() => store.saveArtifact(owner,input.operationId,sid("artifact-session"),"call-1",draft)));
      expect(outcomes.filter(value => value.status === "created")).toHaveLength(1);
      expect(outcomes.filter(value => value.status === "existing")).toHaveLength(2);
      const first = outcomes.find(value => value.status === "created");
      if (!first || first.status !== "created") throw new Error("Artifact was not created.");
      expect(first.artifact).toMatchObject({ title: draft.title,content: draft.content,sourceCallId: "call-1",sourceSessionId: sid("artifact-session"),mediaType: "text/plain" });
      expect(await store.saveArtifact(owner,input.operationId,sid("artifact-session"),"call-1",{ ...draft,content: "Changed" })).toEqual({ status: "conflict" });
      for (const stranger of strangers) {
        expect(await store.getArtifact(stranger,first.artifact.id)).toBeNull();
        expect((await store.listArtifacts(stranger,{})).items).toEqual([]);
      }
      expect(await store.getArtifact(owner,first.artifact.id)).toEqual(first.artifact);
      for (const n of [2,3]) expect((await store.saveArtifact(owner,input.operationId,sid("artifact-session"),`call-${n}`,{ ...draft,title: `Note ${n}` })).status).toBe("created");
      const all = await store.listArtifacts(owner,{}),page1 = await store.listArtifacts(owner,{ limit: 2 });
      expect(all.items).toHaveLength(3);expect(page1.nextCursor).toBeTruthy();
      const page2 = await store.listArtifacts(owner,{ cursor: page1.nextCursor! });
      expect([...page1.items,...page2.items]).toEqual(all.items);
      for (const stranger of strangers) expect(await store.deleteArtifact(stranger,first.artifact.id)).toBe(false);
      expect(await store.deleteArtifact(owner,first.artifact.id)).toBe(true);
      expect(await store.deleteArtifact(owner,first.artifact.id)).toBe(false);
      expect(await store.getArtifact(owner,first.artifact.id)).toBeNull();
      expect((await store.listArtifacts(owner,{})).items.map(item => item.id)).not.toContain(first.artifact.id);
      expect(await store.saveArtifact(owner,input.operationId,sid("artifact-session"),"call-1",draft)).toEqual({ status: "unavailable" });
      expect(await store.saveArtifact(owner,input.operationId,sid("artifact-session"),"call-1",{ ...draft,content: "Changed" })).toEqual({ status: "unavailable" });
      await store.revoke(owner,input.id);
      expect(await store.saveArtifact(owner,input.operationId,sid("artifact-session"),"call-4",draft)).toEqual({ status: "unavailable" });
      expect((await store.listArtifacts(owner,{})).items).toHaveLength(2);
    });
    it("stores immutable projection events once, orders pages and rejects wrong bindings",async () => {
      await store.reserve(input); await store.bind(owner,input.operationId,sid("projection-session"));
      const event = (n: number): ProjectionEntry => ({ schemaVersion: 1,eventId: `evt_${String(n).padStart(26,"0")}`,at: "2026-09-22T12:00:00.000Z",turnId: "turn-one",sequence: 0,payload: { kind: "message",role: "assistant",parts: [{ type: "text",text: `Reply ${n}` }] } });
      for (const stranger of strangers) expect(await store.appendProjection(stranger,input.operationId,sid("projection-session"),event(1))).toBe("unavailable");
      expect(await store.appendProjection(owner,input.operationId,sid("wrong-session"),event(1))).toBe("unavailable");
      const writes = await Promise.all(Array.from({ length: 3 },() => store.appendProjection(owner,input.operationId,sid("projection-session"),event(2))));
      expect(writes.filter(value => value === "inserted")).toHaveLength(1);
      expect(writes.filter(value => value === "duplicate")).toHaveLength(2);
      expect(await store.appendProjection(owner,input.operationId,sid("projection-session"),{ ...event(2),sequence: 2 })).toBe("conflict");
      await store.appendProjection(owner,input.operationId,sid("projection-session"),event(1));
      await store.appendProjection(owner,input.operationId,sid("projection-session"),event(3));
      const first = await store.listProjections(owner,input.operationId,{ limit: 2 });
      expect(first.items.map(({ ingestionIndex,...entry }) => { expect(ingestionIndex).toBeGreaterThan(0); return entry; })).toEqual([event(2),event(1)]);
      expect(first.nextCursor).toBe(first.items[1].ingestionIndex);
      const last = await store.listProjections(owner,input.operationId,{ after: first.nextCursor! });
      expect(last.items.map(({ ingestionIndex,...entry }) => { expect(ingestionIndex).toBeGreaterThan(first.nextCursor!); return entry; })).toEqual([event(3)]);
      // A late write whose source clock is older must still follow the cursor.
      await store.appendProjection(owner,input.operationId,sid("projection-session"),event(0));
      expect((await store.listProjections(owner,input.operationId,{ after: last.items[0].ingestionIndex })).items[0]).toMatchObject(event(0));
      expect(await store.appendProjection(owner,input.operationId,sid("projection-session"),event(2),7)).toBe("duplicate");
      expect(await store.appendProjection(owner,input.operationId,sid("projection-session"),event(2),7)).toBe("duplicate");
      expect(await store.appendProjection(owner,input.operationId,sid("projection-session"),event(2),8)).toBe("conflict");
      expect(await store.appendProjection(owner,input.operationId,sid("projection-session"),event(1),7)).toBe("conflict");
      expect(await store.appendProjection(owner,input.operationId,sid("projection-session"),event(3),9)).toBe("duplicate");
      expect(await store.appendProjection(owner,input.operationId,sid("projection-session"),event(4),9)).toBe("conflict");
      expect((await store.listProjections(owner,input.operationId,{})).items.map(item => [item.eventId,item.sourceIndex]))
        .toEqual([[event(2).eventId,7],[event(1).eventId,undefined],[event(3).eventId,9],[event(0).eventId,undefined]]);
      for (const stranger of strangers) expect((await store.listProjections(stranger,input.operationId,{})).items).toEqual([]);
      await store.revoke(owner,input.id);
      expect(await store.appendProjection(owner,input.operationId,sid("projection-session"),event(4))).toBe("unavailable");
      expect((await store.listProjections(owner,input.operationId,{})).items).toHaveLength(4);
    });
    it("advances only an owned active projection checkpoint with a matching expected cursor",async () => {
      const session = sid("checkpoint-session");
      expect(await store.getProjectionCheckpoint(owner,input.operationId,session)).toBeNull();
      await store.reserve(input);
      expect(await store.getProjectionCheckpoint(owner,input.operationId,session)).toBeNull();
      await store.bind(owner,input.operationId,session);
      expect(await store.getProjectionCheckpoint(owner,input.operationId,session)).toBe(0);
      for (const stranger of strangers) {
        expect(await store.getProjectionCheckpoint(stranger,input.operationId,session)).toBeNull();
        expect(await store.advanceProjectionCheckpoint(stranger,input.operationId,session,0,1)).toBe(false);
      }
      expect(await store.advanceProjectionCheckpoint(owner,input.operationId,sid("wrong-session"),0,1)).toBe(false);
      const winners = await Promise.all([10,20].map(next => store.advanceProjectionCheckpoint(owner,input.operationId,session,0,next)));
      expect(winners.filter(Boolean)).toHaveLength(1);
      const current = await store.getProjectionCheckpoint(owner,input.operationId,session);
      expect([10,20]).toContain(current);
      expect(await store.advanceProjectionCheckpoint(owner,input.operationId,session,0,30)).toBe(false);
      expect(await store.advanceProjectionCheckpoint(owner,input.operationId,session,current!,30)).toBe(true);
      expect(await store.getProjectionCheckpoint(owner,input.operationId,session)).toBe(30);
      await store.revoke(owner,input.id);
      expect(await store.getProjectionCheckpoint(owner,input.operationId,session)).toBeNull();
      expect(await store.advanceProjectionCheckpoint(owner,input.operationId,session,30,31)).toBe(false);
    });
    it("reads one owned metadata record without revealing control fields or changing archive visibility",async () => {
      expect(await store.getDetails(owner,input.operationId)).toBeNull();
      await store.reserve(input,"Private metadata");
      const listed = (await store.list(owner,{})).items[0];
      expect(await store.getDetails(owner,input.operationId)).toEqual(listed);
      for (const stranger of strangers) expect(await store.getDetails(stranger,input.operationId)).toBeNull();
      const changed = await store.updateDetails(owner,input.operationId,{ revision: 1,archived: true });
      expect(await store.getDetails(owner,input.operationId)).toEqual(changed);
      await store.revoke(owner,input.id);
      expect(await store.getDetails(owner,input.operationId)).toMatchObject({ status: "revoked",archived: true });
    });
    it("paginates owner history without duplicates and excludes private control fields", async () => {
      const inputs = Array.from({ length: 5 }, () => ({ ...input, id: randomUUID(), operationId: randomUUID() }));
      await Promise.all(inputs.map((row,index) => store.reserve(row,`Conversation ${index}`)));
      await store.reserve({ ...input,...strangers[0] },"Foreign title");
      const all = await store.list(owner,{});
      expect(all.items).toHaveLength(5);
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await store.list(owner,{ limit: 2,...(cursor ? { cursor } : {}) });
        for (const row of page.items) {
          expect(Object.keys(row).sort()).toEqual(["archived","createdAt","id","operationId","revision","status","title"]);
          expect(row.createdAt).toBeGreaterThan(0); seen.push(row.id);
        }
        cursor = page.nextCursor;
      } while (cursor && seen.length < 10);
      expect(seen).toEqual(all.items.map(row => row.id));
      expect(new Set(seen).size).toBe(5);
      expect((await store.list(strangers[1],{})).items).toEqual([]);
    });
    it("renames and archives with one CAS winner while preserving session ownership", async () => {
      await store.reserve(input,"Initial title"); await store.bind(owner,input.operationId,sid("preserved-session"));
      expect(await store.reserve(input,"Retry cannot rename")).toBe(false);
      expect((await store.list(owner,{})).items[0].title).toBe("Initial title");
      for (const stranger of strangers) expect(await store.updateDetails(stranger,input.operationId,{ revision: 1, title: "Foreign" })).toBeNull();
      const results = await Promise.all(["First","Second"].map(title => store.updateDetails(owner,input.operationId,{ revision: 1,title })));
      expect(results.filter(Boolean)).toHaveLength(1);
      const archived = await store.updateDetails(owner,input.operationId,{ revision: 2,archived: true });
      expect(archived).toMatchObject({ archived: true, revision: 3, status: "active" });
      expect((await store.list(owner,{})).items).toEqual([]);
      expect((await store.list(owner,{ archived: true })).items).toEqual([archived]);
      expect(await store.ownsSession(owner,sid("preserved-session"))).toBe(true);
      expect(await store.updateDetails(owner,input.operationId,{ revision: 2,archived: false })).toBeNull();
      expect(await store.updateDetails(owner,input.operationId,{ revision: 3,archived: false })).toMatchObject({ revision: 4,archived: false });
      expect(await store.getOperation(owner,input.operationId)).toEqual({ ...input,sessionId: sid("preserved-session"),status: "active" });
    });
    it("rejects malformed history filters and mutations before writing", async () => {
      await store.reserve(input);
      for (const options of [{ limit: 0 },{ limit: 51 },{ cursor: "1.or(tenant.eq.foreign)" },{ cursor: `9999999999999999.${input.id}` }]) await expect(store.list(owner,options)).rejects.toBeDefined();
      for (const patch of [{ revision: 1,title: " " },{ revision: 1,title: "x".repeat(121) },{ revision: 1,title: "embedded\u0000control" },{ revision: 1,title: "unpaired\ud800" },{ revision: 1 },{ revision: 1,archived: true,sessionId: "stolen" }]) await expect(store.updateDetails(owner,input.operationId,patch)).rejects.toBeDefined();
      expect((await store.list(owner,{})).items[0]).toMatchObject({ title: "New conversation",revision: 1,archived: false });
    });
    it("grants one creation reservation under concurrent broker requests", async () => {
      const candidates = Array.from({ length: 4 }, () => ({ ...input, id: randomUUID() }));
      const results = await Promise.all(candidates.map(candidate => store.reserve(candidate)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await store.getOperation(owner, input.operationId))?.id).toBe(candidates[results.indexOf(true)].id);
    });
    it("reserves one immutable operation and denies foreign ownership reads and writes", async () => {
      expect(await store.reserve(input)).toBe(true);
      expect(await store.reserve({ ...input, requestHash: "0".repeat(64) })).toBe(false);
      expect(await store.reserve({ ...input, id: randomUUID() })).toBe(false);
      expect(await store.reserve({ ...input, operationId: randomUUID() })).toBe(false);
      expect(await store.getOperation(owner, input.operationId)).toEqual({ ...input, sessionId: null, status: "starting" });
      for (const stranger of strangers) {
        expect(await store.reserve({ ...input, ...stranger, id: randomUUID() })).toBe(false);
        expect(await store.getOperation(stranger, input.operationId)).toBeNull();
        expect(await store.bind(stranger, input.operationId, sid("foreign"))).toBe(false);
        expect(await store.revoke(stranger, input.id)).toBe(false);
      }
    });
    it("allows one concurrent binding, idempotent confirmation, and no rebinding", async () => {
      await store.reserve(input);
      const candidates = [randomUUID(), randomUUID()];
      const results = await Promise.all(candidates.map(id => store.bind(owner, input.operationId, id)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const winner = candidates[results.indexOf(true)];
      expect(await store.bind(owner, input.operationId, winner)).toBe(true);
      expect(await store.ownsSession(owner, winner)).toBe(true);
      expect(await store.ownsSession(owner, randomUUID())).toBe(false);
      for (const stranger of strangers) expect(await store.ownsSession(stranger, winner)).toBe(false);
      const second = { ...input, id: randomUUID(), operationId: randomUUID() };
      await store.reserve(second);
      expect(await store.bind(owner, second.operationId, winner)).toBe(false);
    });
    it("cancels only an unbound start and arbitrates against runtime binding", async () => {
      await store.reserve(input);
      for (const stranger of strangers) expect(await store.cancelStarting(stranger,input.operationId)).toBe(false);
      expect(await store.cancelStarting(owner,input.operationId)).toBe(true);
      expect(await store.cancelStarting(owner,input.operationId)).toBe(false);
      expect(await store.bind(owner,input.operationId,sid("late-runtime"))).toBe(false);
      expect(await store.getOperation(owner,input.operationId)).toMatchObject({ status: "revoked",sessionId: null });

      const active = { ...input,id: randomUUID(),operationId: randomUUID() };
      await store.reserve(active); await store.bind(owner,active.operationId,sid("active-runtime"));
      expect(await store.cancelStarting(owner,active.operationId)).toBe(false);
      expect(await store.ownsSession(owner,sid("active-runtime"))).toBe(true);

      const racing = { ...input,id: randomUUID(),operationId: randomUUID() };
      await store.reserve(racing);
      const [bound,cancelled] = await Promise.all([
        store.bind(owner,racing.operationId,sid("racing-runtime")),
        store.cancelStarting(owner,racing.operationId),
      ]);
      expect(Number(bound)+Number(cancelled)).toBe(1);
      expect((await store.getOperation(owner,racing.operationId))?.status).toBe(bound ? "active" : "revoked");
    });
    it("preserves revoked bindings and prevents reviving pending or active operations", async () => {
      await store.reserve(input);
      const session = randomUUID();
      await store.bind(owner, input.operationId, session);
      expect(await store.revoke(owner, input.id)).toBe(true);
      expect(await store.ownsSession(owner, session)).toBe(false);
      expect(await store.bind(owner, input.operationId, session)).toBe(false);
      const second = { ...input, ...strangers[0], id: randomUUID(), operationId: randomUUID() };
      await store.reserve(second);
      expect(await store.bind(strangers[0], second.operationId, session)).toBe(false);
      await store.revoke(strangers[0], second.id);
      expect(await store.bind(strangers[0], second.operationId, randomUUID())).toBe(false);
    });
    it("arbitrates a global session binding between different owners", async () => {
      const other = { ...input, ...strangers[0], id: randomUUID(), operationId: randomUUID() };
      await Promise.all([store.reserve(input), store.reserve(other)]);
      const session = randomUUID();
      const results = await Promise.all([store.bind(owner, input.operationId, session), store.bind(strangers[0], other.operationId, session)]);
      expect(results.filter(Boolean)).toHaveLength(1);
    });
    it("accepts a replay nonce once under concurrency and retains it through its expiry boundary", async () => {
      const nonce = randomBytes(32).toString("hex"), now = Date.now(), expiry = now + 1000;
      const results = await Promise.all(Array.from({ length: 4 }, () => store.claimNonce(nonce, expiry, now)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(await store.claimNonce(nonce, expiry + 1000, expiry)).toBe(false);
      // Reuse after collection is safe only because the verifier rejects expired signatures.
      expect(await store.claimNonce(nonce, expiry + 1000, expiry + 1)).toBe(true);
      await expect(store.claimNonce(nonce, now, now)).rejects.toBeDefined();
    });
  });
}
