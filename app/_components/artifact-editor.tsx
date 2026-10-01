"use client";

import { useEffect,useId,useRef,useState } from "react";
import { artifact,artifactPatch,artifactVersionPage,type Artifact } from "@/lib/agent-access/artifact-contract";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";

export function ArtifactEditor({ item,settings,userId,onUpdate }: {
  item: Artifact;settings: PublicAuthSettings;userId: string;onUpdate: (value: Artifact) => void;
}) {
  const titleId = useId(),textId = useId();
  const client = browserAuth(settings),controller = useRef<AbortController | null>(null);
  const identity = useRef(userId);
  const [editing,setEditing] = useState(false),[title,setTitle] = useState(item.title),[content,setContent] = useState(item.content);
  const [busy,setBusy] = useState(false),[error,setError] = useState(""),[saved,setSaved] = useState("");
  const [versions,setVersions] = useState<Artifact[] | null>(null),[before,setBefore] = useState<number | null>(null);
  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event,session) => {
      identity.current = session?.user.id ?? "";
      if (identity.current !== userId) controller.current?.abort();
    });
    return () => { data.subscription.unsubscribe();controller.current?.abort(); };
  },[client,userId]);
  async function request(path: string,init: RequestInit = {}) {
    controller.current?.abort();const abort = new AbortController();controller.current = abort;
    const { data,error } = await client.auth.getSession();
    if (error || !data.session || data.session.user.id !== userId || identity.current !== userId) throw new Error("Your account changed or your session expired.");
    const response = await fetch(path,{ ...init,cache: "no-store",signal: AbortSignal.any([abort.signal,AbortSignal.timeout(15_000)]),
      headers: { authorization: `Bearer ${data.session.access_token}`,"content-type": "application/json" } });
    const body = await response.json();
    if (abort.signal.aborted || identity.current !== userId) throw new DOMException("Aborted","AbortError");
    if (!response.ok) throw new Error(body.error?.message ?? "The artifact is unavailable. Try again.");
    return body;
  }
  async function history(next?: number) {
    setBusy(true);setError("");
    try {
      const page = artifactVersionPage.parse(await request(`/api/v1/artifacts/${item.id}/versions?${new URLSearchParams({ limit: "20",...(next !== undefined ? { before: String(next) } : {}) })}`));
      setVersions(previous => next ? [...(previous ?? []),...page.items] : page.items);setBefore(page.nextBefore);
    } catch (error) {
      if (identity.current === userId && !controller.current?.signal.aborted) setError(error instanceof Error ? error.message : "History unavailable.");
    } finally { if (identity.current === userId && !controller.current?.signal.aborted) setBusy(false); }
  }
  async function save() {
    setBusy(true);setError("");setSaved("");
    try {
      const patch = artifactPatch.safeParse({ revision: item.revision,title,content });
      if (!patch.success) throw new Error("Use a plain title of 1–120 characters and well-formed text of 1–32,000 characters.");
      const updated = artifact.parse(await request(`/api/v1/artifacts/${item.id}`,{ method: "PATCH",body: JSON.stringify(patch.data) }));
      onUpdate(updated);setEditing(false);setVersions(null);setBefore(null);setSaved(`Saved version ${updated.revision}.`);
    } catch (error) {
      if (identity.current === userId && !controller.current?.signal.aborted) setError(error instanceof Error ? error.message : "Save failed.");
    } finally { if (identity.current === userId && !controller.current?.signal.aborted) setBusy(false); }
  }
  return <section aria-label={`Versions of ${item.title}`} className="space-y-3">
    <p className="text-sm text-muted-foreground">Version {item.revision} of 100 · Updated {new Date(item.updatedAt).toLocaleString()}</p>
    {error && <p role="alert">{error}</p>}{saved && <p role="status">{saved}</p>}
    {editing ? <form className="space-y-3" onSubmit={event => { event.preventDefault();void save(); }}>
      <div><label htmlFor={titleId}>Artifact title</label><input id={titleId} className="mt-1 block w-full rounded border p-2" required maxLength={120} value={title} onChange={event => setTitle(event.target.value)} /></div>
      <div><label htmlFor={textId}>Artifact text</label><textarea id={textId} className="mt-1 block min-h-40 w-full rounded border p-2" required maxLength={32000} value={content} onChange={event => setContent(event.target.value)} /></div>
      <p className="text-sm">Saving keeps earlier versions, including the original approved text.</p>
      <div className="flex gap-3"><button className="rounded border px-3 py-2" disabled={busy}>Save version</button>
        <button type="button" className="underline" disabled={busy} onClick={() => { setEditing(false);setError(""); }}>Cancel edit</button></div>
    </form> : <button className="underline disabled:opacity-50" disabled={busy || item.revision >= 100} onClick={() => { setTitle(item.title);setContent(item.content);setSaved("");setError("");setEditing(true); }}>Edit artifact</button>}
    <button className="ml-3 underline disabled:opacity-50" disabled={busy} onClick={() => { if (versions) { setVersions(null);setBefore(null); } else void history(); }}>{versions ? "Hide versions" : "Version history"}</button>
    {busy && <p role="status">Loading…</p>}
    {versions && <ol aria-label="Artifact version history" className="space-y-3">{versions.map(version => <li key={version.revision}>
      <details><summary className="cursor-pointer underline">Version {version.revision}{version.revision === 1 ? " · Approved original" : ""} · {version.title}</summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words font-sans text-sm">{version.content}</pre></details>
    </li>)}</ol>}
    {before !== null && <button className="underline" disabled={busy} onClick={() => void history(before)}>Older versions</button>}
  </section>;
}
