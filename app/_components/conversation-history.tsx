"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";
import { conversationSummary, historyPage, type ConversationSummary, type HistoryPatch } from "@/lib/agent-access/contract";

export function ConversationHistory({ settings, userId }: { settings: PublicAuthSettings; userId: string }) {
  const client = browserAuth(settings);
  const identity = useRef(userId);
  const controller = useRef<AbortController | null>(null);
  const [signedIn, setSignedIn] = useState(true);
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<string>();
  const [title, setTitle] = useState("");

  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      identity.current = session?.user.id ?? "";
      if (identity.current !== userId) {
        controller.current?.abort(); setSignedIn(false); setItems([]);
      }
    });
    return () => { data.subscription.unsubscribe(); controller.current?.abort(); };
  }, [client, userId]);

  const request = useCallback(async (path: string, signal: AbortSignal, init?: RequestInit) => {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session || data.session.user.id !== userId || identity.current !== userId) throw new Error("Your account changed or your session expired. Sign in again.");
    const response = await fetch(path, { ...init, cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { authorization: `Bearer ${data.session.access_token}`, ...(init?.body ? { "content-type": "application/json" } : {}) } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? "Conversation history is unavailable. Try again.");
    return body;
  }, [client, userId]);

  const load = useCallback(async (showArchived: boolean, after?: string) => {
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError(""); setEditing(undefined);
    if (!after) { setItems([]); setCursor(null); }
    try {
      const query = new URLSearchParams({ archived: String(showArchived), limit: "20", ...(after ? { cursor: after } : {}) });
      const page = historyPage.parse(await request(`/api/v1/conversations?${query}`, abort.signal));
      if (abort.signal.aborted || identity.current !== userId) return;
      setItems(previous => after ? [...previous, ...page.items.filter(item => !previous.some(existing => existing.id === item.id))] : page.items);
      setCursor(page.nextCursor);
    } catch (error) {
      if (!abort.signal.aborted && identity.current === userId) setError(error instanceof Error ? error.message : "Conversation history is unavailable.");
    } finally { if (!abort.signal.aborted) setBusy(false); }
  }, [request, userId]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(archived); }, 0);
    return () => { clearTimeout(timer); controller.current?.abort(); };
  }, [archived, load]);

  async function update(item: ConversationSummary, patch: Omit<HistoryPatch, "revision">) {
    if (busy) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    try {
      const changed = conversationSummary.parse(await request(`/api/v1/conversations/${item.operationId}`, abort.signal, {
        method: "PATCH", body: JSON.stringify({ ...patch, revision: item.revision }),
      }));
      if (changed.id !== item.id || changed.operationId !== item.operationId) throw new Error("Unexpected conversation response.");
      if (abort.signal.aborted || identity.current !== userId) return;
      setItems(previous => previous.map(value => value.id === changed.id ? changed : value).filter(value => value.archived === archived));
      setEditing(undefined);
    } catch (error) {
      if (!abort.signal.aborted && identity.current === userId) setError(error instanceof Error ? error.message : "Conversation could not be updated.");
    } finally { if (!abort.signal.aborted) setBusy(false); }
  }

  async function cancelStart(item: ConversationSummary) {
    if (busy || item.status !== "starting") return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setBusy(true); setError("");
    try {
      const result = await request(`/api/v1/conversations/${item.operationId}/cancel-start`, abort.signal, { method: "POST" });
      if (result.status !== "cancelled" || result.operationId !== item.operationId || result.conversationId !== item.id) throw new Error("Unexpected cancellation response.");
      if (abort.signal.aborted || identity.current !== userId) return;
      setItems(previous => previous.map(value => value.id === item.id ? { ...value, status: "revoked" } : value));
    } catch (error) {
      if (!abort.signal.aborted && identity.current === userId) setError(error instanceof Error ? error.message : "Conversation could not be cancelled.");
    } finally { if (!abort.signal.aborted) setBusy(false); }
  }

  if (!signedIn) return <main className="p-8"><p role="alert">Your account changed or your session ended.</p><Link href="/login?next=/conversations">Sign in again</Link></main>;
  return <main className="mx-auto max-w-3xl space-y-6 p-6 sm:p-8">
    <h1 className="text-3xl font-medium">Conversations</h1>
    <p className="text-muted-foreground">Reopen a chat or organize your history. You can cancel a start before its runtime begins; archiving keeps a conversation and does not stop an active run.</p>
    <div className="flex gap-4">
      <label className="flex items-center gap-2"><input type="checkbox" checked={archived} onChange={event => {
        controller.current?.abort(); setItems([]); setCursor(null); setBusy(true); setError(""); setArchived(event.target.checked);
      }} />Show archived</label>
      <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load(archived)}>Refresh</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Loading…</p>}
    {!busy && !error && !items.length && <p>No {archived ? "archived " : ""}conversations yet.</p>}
    <ul className="divide-y">{items.map(item => <li key={item.id} className="space-y-3 py-5">
      {item.status === "revoked" ? <p className="font-medium break-words">{item.title}</p> : <Link className="font-medium underline break-words" href={`/s/${item.operationId}`}>{item.title}</Link>}
      <p className="text-sm text-muted-foreground">{item.createdAt ? new Date(item.createdAt).toLocaleString() : "Date unavailable"} · {item.status === "active" ? "Ready to open" : item.status === "starting" ? "Awaiting confirmation" : "Unavailable"}</p>
      {editing === item.id ? <form className="flex flex-wrap gap-3" onSubmit={event => { event.preventDefault(); void update(item, { title }); }}>
        <label className="flex items-center gap-2">Title<input className="rounded border px-3 py-2" value={title} maxLength={120} required onChange={event => setTitle(event.target.value)} /></label>
        <button className="rounded border px-3 py-2" disabled={busy || !title.trim()}>Save title</button>
        <button type="button" disabled={busy} onClick={() => setEditing(undefined)}>Cancel</button>
      </form> : <div className="flex gap-4">
        <Link className="underline" href={`/conversations/${item.operationId}/activity`}>Saved activity</Link>
        <button disabled={busy} onClick={() => { setEditing(item.id); setTitle(item.title); }}>Rename</button>
        <button disabled={busy} onClick={() => void update(item, { archived: !archived })}>{archived ? "Restore" : "Archive"}</button>
        {item.status === "starting" && <button disabled={busy} onClick={() => void cancelStart(item)}>Cancel pending start</button>}
      </div>}
    </li>)}</ul>
    {cursor && <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load(archived, cursor)}>Load more</button>}
  </main>;
}
