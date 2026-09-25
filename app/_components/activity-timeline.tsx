"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
    case "run": return <p>Run {payload.state}{payload.code ? ` (${payload.code})` : ""}</p>;
    case "tool": return <><p>Tool {payload.phase}</p><pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(payload.value, null, 2)}</pre></>;
    case "result": return <><p>Structured result</p><pre className="overflow-x-auto whitespace-pre-wrap break-words text-sm">{JSON.stringify(payload.value, null, 2)}</pre></>;
    case "context": return <p>Context {payload.action}</p>;
    case "omitted": return <p>Large {payload.eventType} event omitted from the saved copy.</p>;
  }
}

export function ActivityTimeline({ settings, userId, operationId }: { settings: PublicAuthSettings; userId: string; operationId: string }) {
  const client = browserAuth(settings);
  const identity = useRef(userId);
  const controller = useRef<AbortController | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [items, setItems] = useState<Activity[]>([]);
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

  const load = useCallback(async (after?: number) => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    if (after === undefined) { setItems([]); setCursor(null); }
    try {
      const { data, error: authError } = await client.auth.getSession();
      if (authError || !data.session || data.session.user.id !== userId || identity.current !== userId) throw new Error("Your account changed or your session expired. Sign in again.");
      const query = new URLSearchParams({ limit: "20", ...(after === undefined ? {} : { after: String(after) }) });
      const response = await fetch(`/api/v1/conversations/${operationId}/events?${query}`, {
        cache: "no-store", signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
        headers: { authorization: `Bearer ${data.session.access_token}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Conversation activity is unavailable. Try again.");
      const page = projectionPage.parse(body);
      if (abort.signal.aborted || identity.current !== userId) return;
      setItems(previous => after === undefined ? page.items : [...previous, ...page.items.filter(item => !previous.some(existing => existing.ingestionIndex === item.ingestionIndex))]);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (!abort.signal.aborted && identity.current === userId) setError(cause instanceof Error ? cause.message : "Conversation activity is unavailable.");
    } finally { if (!abort.signal.aborted) setBusy(false); }
  }, [client, operationId, userId]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); }, 0);
    return () => { clearTimeout(timer); controller.current?.abort(); };
  }, [load]);

  if (!signedIn) return <main className="p-8"><p role="alert">Your account changed or your session ended.</p><Link href="/login?next=/conversations">Sign in again</Link></main>;
  return <main className="mx-auto max-w-3xl space-y-6 p-6 sm:p-8">
    <Link className="underline" href="/conversations">Conversations</Link>
    <h1 className="text-3xl font-medium">Saved activity</h1>
    <p className="text-muted-foreground">This is a partial event record in database ingestion order. Events may be missing or appear after later events. It does not identify which interrupted model attempt entered the final transcript.</p>
    <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load()}>Refresh activity</button>
    {busy && <p role="status">Loading activity…</p>}
    {error && <p role="alert">{error}</p>}
    {!busy && !error && !items.length && <p>No saved activity yet. An empty copy does not prove that the conversation has no events.</p>}
    <ol className="space-y-3">{items.map(item => <li className="rounded border p-4" key={item.eventId}>
      <p className="mb-2 text-sm text-muted-foreground">{new Date(item.at).toLocaleString()} · Saved #{item.ingestionIndex}{item.sourceIndex === undefined ? "" : ` · Source #${item.sourceIndex}`}</p>
      <EventBody payload={item.payload} />
    </li>)}</ol>
    {cursor !== null && <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load(cursor)}>Load more activity</button>}
  </main>;
}
