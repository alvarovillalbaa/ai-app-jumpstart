"use client";
import Link from "next/link";
import { useRef, useState } from "react";
import type { AppRecord, RecordPage } from "@/lib/data/contract";
import { storedStructuredDraft } from "@/lib/agent-access/structured-record";

/** A small reference UI for any backend implementing the versioned record API. */
export function RecordsPanel({ credential, headingLevel = 1 }: { credential?: () => Promise<string>; headingLevel?: 1 | 2 } = {}) {
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(false);
  const [records, setRecords] = useState<AppRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  async function api(path: string, method = "GET", body?: unknown) {
    const active = generation.current;
    const accessToken = credential ? await credential() : token;
    const response = await fetch(`/api/v1/records${path}`, {
      method, headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => null);
      if (response.status === 401 && active === generation.current) { setConnected(false); setRecords([]); setCursor(null); }
      throw new Error(data?.error?.message ?? `Request failed (${response.status}).`);
    }
    return response.status === 204 ? null : response.json();
  }
  async function action(operation: (current: () => boolean) => Promise<void>) {
    const active = generation.current;
    setBusy(true); setError("");
    try { await operation(() => active === generation.current); }
    catch (error) { if (active === generation.current) setError(error instanceof Error ? error.message : "Request failed."); }
    finally { if (active === generation.current) setBusy(false); }
  }
  async function load(current: () => boolean, after?: string) {
    const page: RecordPage = await api(after ? `?after=${encodeURIComponent(after)}` : "");
    if (!current()) return;
    setRecords(previous => after ? [...previous, ...page.items] : page.items);
    setCursor(page.nextCursor); setConnected(true);
  }
  function disconnect() {
    generation.current++; setToken(""); setRecords([]); setCursor(null); setConnected(false); setBusy(false); setError(""); setTitle(""); setContent("");
  }
  const inputClass = "w-full rounded border p-2 bg-background";
  const buttonClass = "rounded border px-4 py-2 disabled:opacity-50";
  return <section className="mx-auto max-w-3xl space-y-6 p-6" aria-labelledby="records-heading">
    {headingLevel === 1 ? <h1 id="records-heading" className="text-2xl font-semibold">Your records</h1> : <h2 id="records-heading" className="text-2xl font-semibold">Your records</h2>}
    <p>Create private notes and use the same data through the API, CLI, and MCP.</p>
    {!connected ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void action(load); }}>
      {!credential && <><label className="block">Access token<input className={inputClass} type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required minLength={32} /></label>
      <p className="text-sm text-muted-foreground">Use a credential issued by your administrator. It stays in this tab’s memory.</p></>}
      <button className={buttonClass} disabled={busy} type="submit">{credential ? "Load records" : "Connect"}</button>
    </form> : <>
      <div className="flex gap-3"><button className={buttonClass} disabled={busy} onClick={() => void action(load)}>Refresh</button><button className={buttonClass} onClick={disconnect}>Disconnect</button></div>
      <form className="space-y-3" onSubmit={event => {
        event.preventDefault(); void action(async current => {
          await api("", "POST", { title, content });
          if (!current()) return;
          setTitle(""); setContent(""); await load(current);
        });
      }}>
        <label className="block">Title<input className={inputClass} value={title} onChange={e => setTitle(e.target.value)} required maxLength={200} /></label>
        <label className="block">Content<textarea className={inputClass} value={content} onChange={e => setContent(e.target.value)} maxLength={32000} rows={4} /></label>
        <button className={buttonClass} disabled={busy || !title.trim()} type="submit">Create record</button>
      </form>
      {records.length ? <ul className="space-y-4">{records.map(record => {
        const draft = credential ? storedStructuredDraft(record.content) : null;
        return <li className="rounded border p-4" key={record.id}><h2 className="font-semibold">{record.title}</h2><p className="whitespace-pre-wrap">{draft ? draft.value.summary : record.content}</p>
          {draft ? <Link className="underline" href={`/structured?draft=${record.id}`}>Open structured draft</Link> : null}<small className="block">Revision {record.revision}</small></li>;
      })}</ul> : <p>No records yet. Create your first one above.</p>}
      {cursor ? <button className={buttonClass} disabled={busy} onClick={() => void action(current => load(current, cursor))}>Load more</button> : null}
    </>}
    {busy ? <p role="status">Working…</p> : null}
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
  </section>;
}
