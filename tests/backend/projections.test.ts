import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageStreamEvent } from "eve/client";
import { projectEvent } from "../../lib/agent-access/projection";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { reconcileProjections } from "../../lib/agent-access/reconcile";

const meta = { id: "evt_00000000000000000000000001",at: "2026-09-22T12:00:00.000Z" };
const message: MessageStreamEvent = { type: "message.completed",meta,data: { message: "A completed block",finishReason: "stop",turnId: "turn-one",sequence: 0,stepIndex: 0 } };
afterEach(() => vi.unstubAllGlobals());
it("projects finalized text and run states while omitting deltas, reasoning, failure diagnostics and file URLs",() => {
  expect(projectEvent(message)?.payload).toEqual({ kind: "message",role: "assistant",parts: [{ type: "text",text: "A completed block" }],finishReason: "stop" });
  expect(projectEvent({ type: "message.appended",meta,data: { messageDelta: "unfinished",turnId: "turn-one",sequence: 0,stepIndex: 0 } })).toBeNull();
  expect(projectEvent({ type: "reasoning.completed",meta,data: { reasoning: "private reasoning",turnId: "turn-one",sequence: 0,stepIndex: 0 } })).toBeNull();
  const failure = projectEvent({ type: "turn.failed",meta,data: { turnId: "turn-one",sequence: 0,code: "PROVIDER_ERROR",message: "secret provider diagnostics",details: { token: "secret" } } });
  expect(failure?.payload).toEqual({ kind: "run",state: "failed",code: "PROVIDER_ERROR" });
  expect(JSON.stringify(failure)).not.toContain("secret");
  const received = projectEvent({ type: "message.received",meta,data: { message: "attachment",turnId: "turn-one",sequence: 0,parts: [{ type: "file",mediaType: "text/plain",filename: "file.txt",url: "https://signed.example/private-token" }] } });
  expect(JSON.stringify(received)).not.toContain("private-token");
});
it("marks oversized completed content explicitly and rejects unstamped events",() => {
  expect(projectEvent({ ...message,data: { ...message.data,message: "x".repeat(60_000) } })?.payload).toEqual({ kind: "omitted",eventType: "message.completed",reason: "size_limit" });
  expect(() => projectEvent({ ...message,meta: { ...meta,id: "unstamped" } })).toThrow();
});
it("upgrades an existing SQLite projection table before storing verified source indexes",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-projection-upgrade-")),path = join(directory,"app.sqlite");
  const owner = { tenant: "org",subject: "alice" },operationId = randomUUID();
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE app_conversation_events (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(operation_id,event_id))");
  old.close();
  try {
    const store = sqliteAccessStore(path);
    try {
      await store.reserve({ ...owner,id: randomUUID(),operationId,requestHash: "a".repeat(64) });
      await store.bind(owner,operationId,"runtime-session");
      expect(await store.getProjectionCheckpoint(owner,operationId,"runtime-session")).toBe(0);
      expect(await store.appendProjection(owner,operationId,"runtime-session",projectEvent(message)!,3)).toBe("inserted");
      expect((await store.listProjections(owner,operationId,{})).items).toMatchObject([{ sourceIndex: 3 }]);
      expect(await store.advanceProjectionCheckpoint(owner,operationId,"runtime-session",0,4)).toBe(true);
    } finally { await store.close(); }
    const reopened = sqliteAccessStore(path);
    try { expect(await reopened.getProjectionCheckpoint(owner,operationId,"runtime-session")).toBe(4); }
    finally { await reopened.close(); }
  } finally { await rm(directory,{ recursive: true,force: true }); }
});
it("repairs a missing projection from a finite authenticated replay and deduplicates repeated recovery",async () => {
  const store = sqliteAccessStore(":memory:"), owner = { tenant: "org",subject: "alice" }, operationId = randomUUID();
  await store.reserve({ ...owner,id: randomUUID(),operationId,requestHash: "a".repeat(64) }); await store.bind(owner,operationId,"runtime-session");
  const fetcher = vi.fn(async (url: URL | string) => {
    const query = new URL(String(url)).searchParams;
    const start = Number(query.get("startIndex") ?? query.get("index") ?? 0);
    return new Response(start === 0 ? `${JSON.stringify(message)}\n` : "",{ headers: { "content-type": "application/x-ndjson","x-eve-stream-version": "25","x-eve-stream-tail-index": "0" } });
  });
  vi.stubGlobal("fetch",fetcher);
  try {
    expect(await reconcileProjections(store,owner,operationId,{},"https://runtime.example","user-token")).toMatchObject({ inserted: 1,duplicates: 0,complete: true,nextIndex: 1,checkpoint: 1 });
    expect(await reconcileProjections(store,owner,operationId,{},"https://runtime.example","user-token")).toMatchObject({ inserted: 0,duplicates: 1,complete: true,checkpoint: 1 });
    expect(await reconcileProjections(store,owner,operationId,{ resume: true },"https://runtime.example","user-token")).toMatchObject({ processed: 0,inserted: 0,nextIndex: 1,checkpoint: 1,complete: true });
    expect((await store.listProjections(owner,operationId,{})).items).toEqual([{ ...projectEvent(message),ingestionIndex: 1,sourceIndex: 0 }]);
    const [url,options] = fetcher.mock.calls[0] as unknown as [URL,RequestInit];
    expect(String(url)).toContain("/eve/v1/session/runtime-session/stream");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer user-token"); expect(options.redirect).toBe("error");
    const calls = fetcher.mock.calls.length;
    await expect(reconcileProjections(store,{ ...owner,subject: "bob" },operationId,{},"https://runtime.example","user-token")).rejects.toMatchObject({ status: 404 });
    await store.revoke(owner,(await store.getOperation(owner,operationId))!.id);
    await expect(reconcileProjections(store,owner,operationId,{},"https://runtime.example","user-token")).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(calls);
  } finally { await store.close(); }
});
it("bounds recovery pages and preserves already copied rows when a provider write fails",async () => {
  const store = sqliteAccessStore(":memory:"), owner = { tenant: "org",subject: "alice" }, operationId = randomUUID();
  await store.reserve({ ...owner,id: randomUUID(),operationId,requestHash: "a".repeat(64) }); await store.bind(owner,operationId,"runtime-session");
  const events = Array.from({ length: 251 },(_,i) => ({ ...message,meta: { ...meta,id: `evt_${String(i+1).padStart(26,"0")}` } }));
  vi.stubGlobal("fetch",vi.fn(async () => new Response(events.map(event => JSON.stringify(event)).join("\n")+"\n",{ headers: { "content-type": "application/x-ndjson","x-eve-stream-version": "25","x-eve-stream-tail-index": "250" } })));
  try {
    const append = vi.spyOn(store,"appendProjection"), original = append.getMockImplementation()!;
    append.mockImplementationOnce(original).mockRejectedValueOnce(new Error("Private provider diagnostics"));
    await expect(reconcileProjections(store,owner,operationId,{},"https://runtime.example","token")).rejects.toMatchObject({ code: "projection_recovery_failed" });
    expect((await store.listProjections(owner,operationId,{})).items).toMatchObject([{ sourceIndex: 0 }]);
    expect(await store.getProjectionCheckpoint(owner,operationId,"runtime-session")).toBe(0);
    expect(await reconcileProjections(store,owner,operationId,{ resume: true },"https://runtime.example","token")).toMatchObject({ processed: 250,inserted: 249,duplicates: 1,nextIndex: 250,checkpoint: 250,complete: false });
    vi.stubGlobal("fetch",vi.fn(async () => new Response(JSON.stringify(events[250])+"\n",{ headers: { "content-type": "application/x-ndjson","x-eve-stream-version": "25","x-eve-stream-tail-index": "250" } })));
    expect(await reconcileProjections(store,owner,operationId,{ resume: true },"https://runtime.example","token")).toMatchObject({ processed: 1,inserted: 1,nextIndex: 251,checkpoint: 251,complete: true });
  } finally { await store.close(); }
});
it("does not advance the checkpoint when a caller replays beyond an unverified gap",async () => {
  const store = sqliteAccessStore(":memory:"),owner = { tenant: "org",subject: "alice" },operationId = randomUUID();
  await store.reserve({ ...owner,id: randomUUID(),operationId,requestHash: "a".repeat(64) });
  await store.bind(owner,operationId,"runtime-session");
  vi.stubGlobal("fetch",vi.fn(async () => new Response(`${JSON.stringify(message)}\n`,{
    headers: { "content-type": "application/x-ndjson","x-eve-stream-version": "25","x-eve-stream-tail-index": "10" },
  })));
  try {
    expect(await reconcileProjections(store,owner,operationId,{ startIndex: 10 },"https://runtime.example","user-token"))
      .toMatchObject({ nextIndex: 11,checkpoint: 0,complete: true });
    expect((await store.listProjections(owner,operationId,{})).items).toMatchObject([{ sourceIndex: 10 }]);
    expect(await store.getProjectionCheckpoint(owner,operationId,"runtime-session")).toBe(0);
  } finally { await store.close(); }
});
