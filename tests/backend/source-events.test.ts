import { randomUUID } from "node:crypto";
import { afterEach,expect,it,vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { readSourceEvents } from "../../lib/agent-access/source-events";

const owner = { tenant: "org",subject: "alice" };
const first: MessageStreamEvent = { type: "message.appended",meta: { id: "evt_00000000000000000000000003",at: "2026-09-25T09:00:00.000Z" },
  data: { messageDelta: "partial",turnId: "turn-one",sequence: 0,stepIndex: 0 } };
const second: MessageStreamEvent = { type: "message.completed",meta: { id: "evt_00000000000000000000000002",at: "2026-09-25T09:00:01.000Z" },
  data: { message: "Final answer",finishReason: "stop",turnId: "turn-one",sequence: 0,stepIndex: 0 } };
const third: MessageStreamEvent = { type: "turn.completed",meta: { id: "evt_00000000000000000000000001",at: "2026-09-25T09:00:02.000Z" },
  data: { turnId: "turn-one",sequence: 0 } };
afterEach(() => vi.unstubAllGlobals());

it("pages selected events by absolute stream index rather than event ID or ingestion order",async () => {
  const store = sqliteAccessStore(":memory:"),operation = randomUUID(),events = [first,second,third];
  await store.reserve({ ...owner,id: randomUUID(),operationId: operation,requestHash: "a".repeat(64) });
  await store.bind(owner,operation,"runtime-session");
  const fetcher = vi.fn(async (url: URL | string) => {
    const requested = new URL(String(url));
    const start = Number(requested.searchParams.get("startIndex") ?? requested.searchParams.get("index") ?? 0);
    return new Response(events.slice(start).map(event => JSON.stringify(event)).join("\n")+"\n",{
      headers: { "content-type": "application/x-ndjson","x-eve-stream-version": "25","x-eve-stream-tail-index": "2" },
    });
  });
  vi.stubGlobal("fetch",fetcher);
  try {
    const defaults = await readSourceEvents(store,owner,operation,undefined,"https://runtime.example","user-token");
    expect(defaults).toMatchObject({ source: "eve-durable-stream",scanned: 3,nextIndex: 3,complete: true });
    const page = await readSourceEvents(store,owner,operation,{ limit: 1 },"https://runtime.example","user-token");
    expect(page).toMatchObject({ source: "eve-durable-stream",scanned: 2,nextIndex: 2,complete: false,
      items: [{ sourceIndex: 1,eventId: second.meta.id,payload: { kind: "message",role: "assistant" } }] });
    expect(JSON.stringify(page)).not.toContain("partial");
    const tail = await readSourceEvents(store,owner,operation,{ startIndex: page.nextIndex },"https://runtime.example","user-token");
    expect(tail).toMatchObject({ scanned: 1,nextIndex: 3,complete: true,
      items: [{ sourceIndex: 2,eventId: third.meta.id,payload: { kind: "run",state: "completed" } }] });
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [url,options] = fetcher.mock.calls[1] as unknown as [URL,RequestInit];
    expect(String(url)).toContain("/eve/v1/session/runtime-session/stream");
    expect(new Headers(options.headers).get("authorization")).toBe("Bearer user-token");
    expect(options.redirect).toBe("error");
    await expect(readSourceEvents(store,{ ...owner,subject: "bob" },operation,{},"https://runtime.example","user-token"))
      .rejects.toMatchObject({ status: 404 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally { await store.close(); }
});

it("fails closed for an invalid source event and a revoked binding",async () => {
  const store = sqliteAccessStore(":memory:"),operation = randomUUID();
  const reservationId = randomUUID();
  await store.reserve({ ...owner,id: reservationId,operationId: operation,requestHash: "a".repeat(64) });
  await store.bind(owner,operation,"runtime-session");
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ ...second,meta: { ...second.meta,id: "unstamped" } })+"\n",{
    headers: { "content-type": "application/x-ndjson","x-eve-stream-version": "25","x-eve-stream-tail-index": "0" },
  }));
  vi.stubGlobal("fetch",fetcher);
  try {
    await expect(readSourceEvents(store,owner,operation,{},"https://runtime.example","user-token"))
      .rejects.toMatchObject({ status: 503,code: "source_events_unavailable" });
    await store.revoke(owner,reservationId);
    await expect(readSourceEvents(store,owner,operation,{},"https://runtime.example","user-token"))
      .rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { await store.close(); }
});
