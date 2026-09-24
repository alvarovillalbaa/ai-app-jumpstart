"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { artifactPage, type Artifact } from "@/lib/agent-access/artifact-contract";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";

export function ArtifactLibrary({ settings,userId }: { settings: PublicAuthSettings;userId: string }) {
  const client = browserAuth(settings);
  const identity = useRef(userId);
  const controller = useRef<AbortController | null>(null);
  const [signedIn,setSignedIn] = useState(true);
  const [items,setItems] = useState<Artifact[]>([]);
  const [cursor,setCursor] = useState<string | null>(null);
  const [busy,setBusy] = useState(true);
  const [acting,setActing] = useState<string | null>(null);
  const [error,setError] = useState("");

  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event,session) => {
      identity.current = session?.user.id ?? "";
      if (identity.current !== userId) {
        controller.current?.abort(); setSignedIn(false); setItems([]); setCursor(null);
      }
    });
    return () => { data.subscription.unsubscribe();controller.current?.abort(); };
  },[client,userId]);

  const load = useCallback(async (after?: string) => {
    controller.current?.abort();const abort = new AbortController();controller.current = abort;
    setBusy(true);setError("");
    if (!after) { setItems([]);setCursor(null); }
    try {
      const { data,error } = await client.auth.getSession();
      if (error || !data.session || data.session.user.id !== userId || identity.current !== userId) throw new Error("Your account changed or your session expired. Sign in again.");
      const query = new URLSearchParams({ limit: "20",...(after ? { cursor: after } : {}) });
      const response = await fetch(`/api/v1/artifacts?${query}`,{
        cache: "no-store",signal: AbortSignal.any([abort.signal,AbortSignal.timeout(15_000)]),
        headers: { authorization: `Bearer ${data.session.access_token}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Artifacts are unavailable. Try again.");
      const page = artifactPage.parse(body);
      if (abort.signal.aborted || identity.current !== userId) return;
      setItems(previous => after ? [...previous,...page.items.filter(item => !previous.some(existing => existing.id === item.id))] : page.items);
      setCursor(page.nextCursor);
    } catch (error) {
      if (!abort.signal.aborted && identity.current === userId) setError(error instanceof Error ? error.message : "Artifacts are unavailable.");
    } finally { if (!abort.signal.aborted) setBusy(false); }
  },[client,userId]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); },0);
    return () => { clearTimeout(timer);controller.current?.abort(); };
  },[load]);

  const act = async (item: Artifact,action: "download" | "delete") => {
    if (action === "delete" && !window.confirm(`Delete “${item.title}”? This erases its saved text and cannot be undone.`)) return;
    setActing(item.id);setError("");
    try {
      const { data,error } = await client.auth.getSession();
      if (error || !data.session || data.session.user.id !== userId || identity.current !== userId) throw new Error("Your account changed or your session expired. Sign in again.");
      const response = await fetch(`/api/v1/artifacts/${item.id}${action === "download" ? "/download" : ""}`,{
        method: action === "delete" ? "DELETE" : "GET",cache: "no-store",signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${data.session.access_token}` },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error?.message ?? "The artifact is unavailable. Try again.");
      }
      if (identity.current !== userId) return;
      if (action === "delete") setItems(previous => previous.filter(saved => saved.id !== item.id));
      else {
        const blob = await response.blob();
        if (identity.current !== userId) return;
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");link.href = url;link.download = `artifact-${item.id}.txt`;
        link.click();setTimeout(() => URL.revokeObjectURL(url),0);
      }
    } catch (error) {
      if (identity.current === userId) setError(error instanceof Error ? error.message : "The artifact is unavailable.");
    } finally { setActing(null); }
  };

  if (!signedIn) return <main className="p-8"><p role="alert">Your account changed or your session ended.</p><Link href="/login?next=/artifacts">Sign in again</Link></main>;
  return <main className="mx-auto max-w-3xl space-y-6 p-6 sm:p-8">
    <h1 className="text-3xl font-medium">Artifacts</h1>
    <p className="text-muted-foreground">Private plain-text artifacts saved after approval in a conversation.</p>
    <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load()}>Refresh</button>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Loading…</p>}
    {!busy && !error && !items.length && <p>No artifacts yet.</p>}
    <ul className="divide-y">{items.map(item => <li key={item.id} className="space-y-2 py-5">
      <h2 className="font-medium break-words">{item.title}</h2>
      <p className="text-sm text-muted-foreground">{new Date(item.createdAt).toLocaleString()} · <Link className="underline" href={`/s/${item.operationId}`}>Source conversation</Link></p>
      <details><summary className="cursor-pointer underline">View text</summary><pre className="mt-3 max-h-96 overflow-auto rounded border p-4 whitespace-pre-wrap break-words font-sans text-sm">{item.content}</pre></details>
      <div className="flex gap-3"><button className="underline disabled:opacity-50" disabled={busy || acting !== null} onClick={() => void act(item,"download")}>Download .txt</button>
        <button className="underline disabled:opacity-50" disabled={busy || acting !== null} onClick={() => void act(item,"delete")}>Delete</button></div>
    </li>)}</ul>
    {cursor && <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load(cursor)}>Load more</button>}
  </main>;
}
