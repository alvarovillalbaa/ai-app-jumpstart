"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { runPage,runView } from "@/lib/agent-access/run-contract";
import type { z } from "zod";
import { projectionPage, type ProjectionEntry } from "@/lib/agent-access/projection-contract";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";

type Activity = ProjectionEntry & { ingestionIndex: number; sourceIndex?: number };

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

export function ActivityTimeline({ settings, userId, operationId,view = "activity",runtimeEnabled = true }: { settings: PublicAuthSettings; userId: string; operationId: string; view?: "activity"|"runs";runtimeEnabled?: boolean }) {
  const client = browserAuth(settings);
  const identity = useRef(userId);
  const controller = useRef<AbortController | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [items, setItems] = useState<Array<Activity | z.infer<typeof runView>>>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      identity.current = session?.user.id ?? "";
      if (identity.current !== userId) {
        controller.current?.abort(); setSignedIn(false); setItems([]); setCursor(null);
      }
    });
    return () => { data.subscription.unsubscribe(); controller.current?.abort(); };
  }, [client, userId]);

  const load = useCallback(async (after?: number,verify = false) => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    if (after === undefined && !verify) { setItems([]); setCursor(null); }
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
      const query = new URLSearchParams({ limit: "20", ...(after === undefined ? {} : { after: String(after) }) });
      const response = await fetch(`/api/v1/conversations/${operationId}/${view === "runs" ? "runs" : "events"}?${query}`, {
        cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        headers: { authorization: `Bearer ${data.session.access_token}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Conversation activity is unavailable. Try again.");
      const page = view === "runs" ? runPage.parse(body) : projectionPage.parse(body);
      if (abort.signal.aborted || identity.current !== userId) return;
      setItems(previous => after === undefined ? page.items : [...previous, ...page.items.filter(item => !previous.some(existing => ("eventId" in existing ? existing.eventId : existing.turnId) === ("eventId" in item ? item.eventId : item.turnId)))]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (!abort.signal.aborted && identity.current === userId) setError(cause instanceof Error ? cause.message : "Conversation activity is unavailable.");
    } finally { if (!abort.signal.aborted) setBusy(false); }
  }, [client, operationId, userId,view,runtimeEnabled]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => { clearTimeout(timer); controller.current?.abort(); };
  }, [load]);

  if (!signedIn) return <main className="p-8"><p role="alert">Your account changed or your session ended.</p><Link href="/login?next=/conversations">Sign in again</Link></main>;
  return <main className="mx-auto max-w-3xl space-y-6 p-6 sm:p-8">
    <Link className="underline" href="/conversations">Conversations</Link>
    <h1 className="text-3xl font-medium">{view === "runs" ? "Run history" : "Saved activity"}</h1>
    <Link className="underline" href={`/conversations/${operationId}/${view === "runs" ? "activity" : "runs"}`}>{view === "runs" ? "Saved activity" : "Run history"}</Link>
    <p className="text-muted-foreground">{view === "runs" ? runtimeEnabled ? "Some runs are still awaiting verification. Check history to look for updates." : "Chat is paused. These are saved run summaries; incomplete coverage remains awaiting verification." : "This is a partial event record in database ingestion order. Events may be missing or appear after later events. It does not identify which interrupted model attempt entered the final transcript."}</p>
    <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load()}>{view === "runs" ? "Refresh runs" : "Refresh activity"}</button>
    {view === "runs" && runtimeEnabled && <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load(undefined,true)}>Check history</button>}
    {busy && <p role="status">{view === "runs" ? "Loading runs…" : "Loading activity…"}</p>}
    {error && <p role="alert">{error}</p>}
    {!busy && !error && !items.length && <p>{view === "runs" ? "No saved runs yet. An empty copy does not prove that the conversation has no runs." : "No saved activity yet. An empty copy does not prove that the conversation has no events."}</p>}
    <ol className="space-y-3">{items.map(item => <li className="rounded border p-4" key={"eventId" in item ? item.eventId : item.turnId}>
      {"payload" in item ? <>
        <p className="mb-2 text-sm text-muted-foreground">{new Date(item.at).toLocaleString()} · Saved #{item.ingestionIndex}{item.sourceIndex === undefined ? "" : ` · Source #${item.sourceIndex}`}</p>
        <EventBody payload={item.payload} />
      </> : <>
        <h2 className="font-medium">{item.state === "unverified" ? "Awaiting verification" : `Run ${item.state}`}</h2>
        {item.startedAt && <p className="text-sm text-muted-foreground">Started {new Date(item.startedAt).toLocaleString()}</p>}
        {item.lastBoundaryAt && item.state !== "unverified" && <p className="text-sm text-muted-foreground">Last update {new Date(item.lastBoundaryAt).toLocaleString()}</p>}
        <p className="break-words">{item.models.length ? `Models: ${item.models.join(", ")}` : "Model information has not been captured."}</p>
        {item.code && <p>Failure code: {item.code}</p>}
      </>}
    </li>)}</ol>
    {cursor !== null && <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load(cursor)}>{view === "runs" ? "Load more runs" : "Load more activity"}</button>}
  </main>;
}
