"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { runPage,runView } from "@/lib/agent-access/run-contract";
import type { z } from "zod";
import { projectionPage, type ProjectionEntry } from "@/lib/agent-access/projection-contract";
import { sourceEventPage } from "@/lib/agent-access/source-contract";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";

type Activity = ProjectionEntry & { ingestionIndex: number; sourceIndex?: number };
type SourceEvent = z.infer<typeof sourceEventPage>["items"][number];

function EventBody({ payload }: { payload: ProjectionEntry["payload"] }) {
  switch (payload.kind) {
    case "message": return <>
      <p className="font-medium">{payload.role === "user" ? "You" : "Assistant"}</p>
      {payload.parts.length ? payload.parts.map((part, index) => part.type === "text"
        ? <p className="whitespace-pre-wrap break-words" key={index}>{part.text}</p>
        : <p className="break-words" key={index}>Attachment: {part.filename ?? "Unnamed file"} ({part.mediaType})</p>)
        : <p className="text-muted-foreground">No text captured.</p>}
    </>;
    case "model": return <p>Model: {payload.modelId}</p>;
    case "run": return <p>Run {payload.state}{payload.code ? ` (${payload.code})` : ""}</p>;
    case "tool": return <><p>Tool {payload.phase}</p><pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(payload.value, null, 2)}</pre></>;
    case "result": return <><p>Structured result</p><pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(payload.value, null, 2)}</pre></>;
    case "context": return <p>Context {payload.action}</p>;
    case "omitted": return <p>Large {payload.eventType} event omitted from the saved copy.</p>;
  }
}

export function ActivityTimeline({ settings, userId, operationId,view = "activity",runtimeEnabled = true }: { settings: PublicAuthSettings; userId: string; operationId: string; view?: "activity"|"runs"|"source";runtimeEnabled?: boolean }) {
  const client = browserAuth(settings);
  const identity = useRef(userId);
  const controller = useRef<AbortController | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [items, setItems] = useState<Array<Activity | SourceEvent | z.infer<typeof runView>>>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [sourceComplete, setSourceComplete] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      identity.current = session?.user.id ?? "";
      if (identity.current !== userId) {
        controller.current?.abort(); setSignedIn(false); setItems([]); setCursor(null); setSourceComplete(false);
      }
    });
    return () => { data.subscription.unsubscribe(); controller.current?.abort(); };
  }, [client, userId]);

  const load = useCallback(async (after?: number,verify = false) => {
    if (view === "source" && !runtimeEnabled) {
      controller.current?.abort(); setItems([]); setCursor(null); setSourceComplete(false); setError(""); setBusy(false);
      return;
    }
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    if (after === undefined && !verify) { setItems([]); setCursor(null); setSourceComplete(false); }
    try {
      const { data, error: authError } = await client.auth.getSession();
      if (authError || !data.session || data.session.user.id !== userId || identity.current !== userId) throw new Error("Your account changed or your session expired. Sign in again.");
      if (verify && runtimeEnabled) {
        const recovery = await fetch(`/api/v1/conversations/${operationId}/reconcile`,{
          method: "POST",signal: AbortSignal.any([abort.signal,AbortSignal.timeout(25_000)]),
          headers: { authorization: `Bearer ${data.session.access_token}`,"content-type": "application/json" },body: JSON.stringify({ resume: true }),
        });
        if (!recovery.ok) throw new Error("History verification is unavailable. You can still refresh the saved history.");
      }
      const query = view === "source"
        ? new URLSearchParams({ startIndex: String(after ?? 0),limit: "20" })
        : new URLSearchParams({ limit: "20", ...(after === undefined ? {} : { after: String(after) }) });
      const endpoint = view === "source" ? "source-events" : view === "runs" ? "runs" : "events";
      const response = await fetch(`/api/v1/conversations/${operationId}/${endpoint}?${query}`, {
        cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        headers: { authorization: `Bearer ${data.session.access_token}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Conversation activity is unavailable. Try again.");
      if (view === "source") {
        const page = sourceEventPage.parse(body);
        if (abort.signal.aborted || identity.current !== userId) return;
        setItems(previous => after === undefined ? page.items : [...previous, ...page.items.filter(item => !previous.some(existing => "sourceIndex" in existing && existing.sourceIndex === item.sourceIndex))]);
        setCursor(page.complete ? null : page.nextIndex);
        setSourceComplete(page.complete);
      } else {
        const page = view === "runs" ? runPage.parse(body) : projectionPage.parse(body);
        if (abort.signal.aborted || identity.current !== userId) return;
        setItems(previous => after === undefined ? page.items : [...previous, ...page.items.filter(item => !previous.some(existing => ("eventId" in existing ? existing.eventId : existing.turnId) === ("eventId" in item ? item.eventId : item.turnId)))]);
        setCursor(page.nextCursor);
      }
    } catch (cause) {
      if (!abort.signal.aborted && identity.current === userId) setError(cause instanceof Error ? cause.message : "Conversation history is unavailable.");
    } finally { if (!abort.signal.aborted) setBusy(false); }
  }, [client, operationId, userId,view,runtimeEnabled]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => { clearTimeout(timer); controller.current?.abort(); };
  }, [load]);

  if (!signedIn) return <main className="p-8"><p role="alert">Your account changed or your session ended.</p><Link href="/login?next=/conversations">Sign in again</Link></main>;
  return <main className="mx-auto max-w-3xl space-y-6 p-6 sm:p-8">
    <Link className="underline" href="/conversations">Conversations</Link>
    <h1 className="text-3xl font-medium">{view === "runs" ? "Run history" : view === "source" ? "Source stream" : "Saved activity"}</h1>
    <nav aria-label="Conversation history views" className="flex flex-wrap gap-4">
      <Link className="underline" href={`/conversations/${operationId}/activity`}>Saved activity</Link>
      <Link className="underline" href={`/conversations/${operationId}/runs`}>Run history</Link>
      {runtimeEnabled && <Link className="underline" href={`/conversations/${operationId}/source`}>Source stream</Link>}
    </nav>
    <p className="text-muted-foreground">{view === "runs"
      ? runtimeEnabled ? "Some runs are still awaiting verification. Check history to look for updates." : "Chat is paused. These are saved run summaries; incomplete coverage remains awaiting verification."
      : view === "source"
        ? "Read-only selected events in exact Eve source order, including interrupted attempts. This is not canonical model history and cannot identify which attempt produced the final answer. Reading does not dispatch a model turn."
        : "This is a partial event record in database ingestion order. Events may be missing or appear after later events. It does not identify which interrupted model attempt entered the final transcript."}</p>
    {view === "source" && !runtimeEnabled && <p role="status">Source stream reading requires enabled account chat.</p>}
    <button className="rounded border px-3 py-2" disabled={busy || (view === "source" && !runtimeEnabled)} onClick={() => void load()}>{view === "runs" ? "Refresh runs" : view === "source" ? "Refresh source stream" : "Refresh activity"}</button>
    {view === "runs" && runtimeEnabled && <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load(undefined,true)}>Check history</button>}
    {busy && <p role="status">{view === "runs" ? "Loading runs…" : view === "source" ? "Loading source events…" : "Loading activity…"}</p>}
    {error && <p role="alert">{error}</p>}
    {!busy && !error && view === "source" && !items.length && <p>{cursor !== null ? "This scanned page had no displayable events. Continue to advance over non-renderable stream entries." : "No displayable source events were found in the observed stream. Later events may still arrive."}</p>}
    {!busy && !error && view === "source" && sourceComplete && !!items.length && <p className="text-sm text-muted-foreground">Reached the source stream tail observed for this read. Later events may still arrive.</p>}
    {!busy && !error && view !== "source" && !items.length && <p>{view === "runs" ? "No saved runs yet. An empty copy does not prove that the conversation has no runs." : "No saved activity yet. An empty copy does not prove that the conversation has no events."}</p>}
    <ol className="space-y-3">{items.map(item => <li className="rounded border p-4" key={"eventId" in item ? item.eventId : item.turnId}>
      {"payload" in item ? <>
        <p className="mb-2 text-sm text-muted-foreground">{new Date(item.at).toLocaleString()} · {"sourceIndex" in item && view === "source" ? "Source #" + item.sourceIndex : "ingestionIndex" in item ? "Saved #" + item.ingestionIndex : "Source index unavailable"}</p>
        <EventBody payload={item.payload} />
      </> : <>
        <h2 className="font-medium">{item.state === "unverified" ? "Awaiting verification" : `Run ${item.state}`}</h2>
        {item.startedAt && <p className="text-sm text-muted-foreground">Started {new Date(item.startedAt).toLocaleString()}</p>}
        {item.lastBoundaryAt && item.state !== "unverified" && <p className="text-sm text-muted-foreground">Last update {new Date(item.lastBoundaryAt).toLocaleString()}</p>}
        <p className="break-words">{item.models.length ? `Models: ${item.models.join(", ")}` : "Model information has not been captured."}</p>
        {item.code && <p>Failure code: {item.code}</p>}
      </>}
    </li>)}</ol>
    {cursor !== null && <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load(cursor)}>{view === "runs" ? "Load more runs" : view === "source" ? "Load more source events" : "Load more activity"}</button>}
  </main>;
}
