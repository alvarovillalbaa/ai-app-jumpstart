"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { z } from "zod";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";
import { operationId, sessionId } from "@/lib/agent-access/contract";
import { projectionPage } from "@/lib/agent-access/projection-contract";
import { structuredDraft, structuredRecord, storedStructuredDraft } from "@/lib/agent-access/structured-record";

const receipt = z.discriminatedUnion("status",[
  z.object({ operationId,status: z.literal("starting"),sessionId: z.null() }),
  z.object({ operationId,status: z.literal("active"),sessionId }),
]);
type RecordValue = z.infer<typeof structuredRecord>;
const savedRecord = z.object({ id: z.uuid(),revision: z.number().int().positive(),title: z.string(),content: z.string() });
class HttpFailure extends Error { constructor(public status: number,message: string) { super(message); } }

export function StructuredForm({ settings,userId,initialOperationId,initialDraftId }: {
  settings: PublicAuthSettings;userId: string;initialOperationId?: string;initialDraftId?: string;
}) {
  const { url,publishableKey } = settings;
  const client = useMemo(() => browserAuth({ url,publishableKey }),[url,publishableKey]);
  const activeUser = useRef(userId), controller = useRef<AbortController | null>(null), submitted = useRef(false);
  const [signedIn,setSignedIn] = useState(true);
  const [source,setSource] = useState("");
  const [operation,setOperation] = useState(initialOperationId);
  const [phase,setPhase] = useState<"idle"|"starting"|"running"|"recovering"|"complete"|"pending"|"failed">(initialOperationId || initialDraftId ? "starting" : "idle");
  const [value,setValue] = useState<RecordValue>();
  const [draft,setDraft] = useState<{ id: string;revision: number }>();
  const [savedContent,setSavedContent] = useState<string>();
  const [saving,setSaving] = useState(false);
  const [saveError,setSaveError] = useState("");
  const [error,setError] = useState("");

  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event,current) => {
      activeUser.current = current?.user.id ?? "";
      if (activeUser.current !== userId) { controller.current?.abort();setSignedIn(false);setValue(undefined);setDraft(undefined); }
    });
    return () => { data.subscription.unsubscribe();controller.current?.abort(); };
  },[client,userId]);

  const credential = useCallback(async () => {
    const { data,error } = await client.auth.getSession();
    if (error || !data.session || data.session.user.id !== userId || activeUser.current !== userId) throw new Error("Your account changed or your session expired. Sign in again.");
    return data.session.access_token;
  },[client,userId]);

  const json = useCallback(async (url: string,signal: AbortSignal,body?: object,method?: "POST" | "PATCH",timeoutMs = 15_000) => {
    const token = await credential();
    const response = await fetch(url,{ method: method ?? (body ? "POST" : "GET"),headers: { authorization: `Bearer ${token}`,...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,cache: "no-store",signal: AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]) });
    const data: unknown = await response.json();
    if (!response.ok) throw new HttpFailure(response.status,z.object({ error: z.object({ message: z.string() }) }).safeParse(data).data?.error.message ?? "The request could not be completed.");
    return data;
  },[credential]);

  const replay = useCallback(async (id: string,signal: AbortSignal) => {
    let startIndex = 0;
    for (let page = 0;page < 20;page++) {
      const response = z.object({ nextIndex: z.number().int(),complete: z.boolean() }).parse(
        await json(`/api/v1/conversations/${id}/reconcile`,signal,{ startIndex },undefined,25_000));
      startIndex = response.nextIndex;
      if (response.complete) return;
    }
    throw new Error("Recovery reached its page limit. Contact an operator to continue from the remaining source index.");
  },[json]);

  const check = useCallback(async (id: string,signal: AbortSignal,allowRecovery = true) => {
    let deadline = Date.now()+60_000;
    let cursor = 0,produced: RecordValue | undefined,recovered = !allowRecovery;
    try {
      while (!signal.aborted) {
        if (Date.now() >= deadline) {
          if (recovered) { if (activeUser.current === userId) setPhase("pending");return; }
          if (activeUser.current !== userId) return;
          recovered = true;setPhase("recovering");await replay(id,signal);
          cursor = 0;produced = undefined;deadline = Date.now()+60_000;
          continue;
        }
        const state = receipt.parse(await json(`/api/v1/conversations/${id}`,signal));
        if (state.operationId !== id) throw new Error("Unexpected conversation response.");
        if (state.status === "active") {
          if (activeUser.current === userId) setPhase("running");
          let completed = false,terminal: string | undefined;
          do {
            const page = projectionPage.parse(await json(`/api/v1/conversations/${id}/events?limit=50&after=${cursor}`,signal));
            for (const event of page.items) {
              cursor = event.ingestionIndex;
              if (event.payload.kind === "result") {
                const parsed = structuredRecord.safeParse(event.payload.value);
                if (!parsed.success) throw new Error("The result did not match the structured fields.");
                produced = parsed.data;
              }
              if (event.payload.kind === "run") {
                if (event.payload.state === "completed") completed = true;
                if (event.payload.state === "failed" || event.payload.state === "cancelled") terminal = `${event.payload.state}${event.payload.code ? ` (${event.payload.code})` : ""}`;
              }
            }
            if (!page.nextCursor) break;
          } while (!signal.aborted);
          if (completed && produced) {
            if (!signal.aborted && activeUser.current === userId) { setValue(produced);setPhase("complete");setError(""); }
            return;
          }
          if (terminal) throw new Error(`The run ${terminal}. You can start a new result.`);
          if (completed) {
            if (recovered) throw new Error("The run completed, but its structured result is unavailable. Try Recover result.");
            if (signal.aborted || activeUser.current !== userId) return;
            recovered = true;setPhase("recovering");await replay(id,signal);
            cursor = 0;produced = undefined;deadline = Date.now()+60_000;
            continue;
          }
        }
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer);signal.removeEventListener("abort",done);resolve(); };
          const timer = setTimeout(done,1000);
          signal.addEventListener("abort",done,{ once: true });
        });
      }
    } catch (cause) {
      if (!signal.aborted && activeUser.current === userId) { setError(cause instanceof Error ? cause.message : "The result is unavailable.");setPhase("failed"); }
    }
  },[json,replay,userId]);

  useEffect(() => {
    if (!initialOperationId || initialDraftId) return;
    const abort = new AbortController();controller.current = abort;
    const timer = setTimeout(() => { void check(initialOperationId,abort.signal); },0);
    return () => { clearTimeout(timer);abort.abort(); };
  },[initialOperationId,initialDraftId,check]);

  useEffect(() => {
    if (!initialDraftId) return;
    const abort = new AbortController();controller.current = abort;
    const timer = setTimeout(() => { void (async () => {
      try {
        const row = savedRecord.parse(await json(`/api/v1/records/${initialDraftId}`,abort.signal));
        const stored = storedStructuredDraft(row.content);
        if (!stored) throw new Error("This record is not a compatible structured draft.");
        await json(`/api/v1/conversations/${stored.sourceOperationId}/metadata`,abort.signal);
        if (abort.signal.aborted || activeUser.current !== userId) return;
        setOperation(stored.sourceOperationId);setValue(stored.value);setDraft({ id: row.id,revision: row.revision });
        setSavedContent(JSON.stringify(stored));setPhase("complete");setError("");
      } catch (cause) {
        if (!abort.signal.aborted && activeUser.current === userId) { setError(cause instanceof Error ? cause.message : "Draft unavailable.");setPhase("failed"); }
      }
    })(); },0);
    return () => { clearTimeout(timer);abort.abort(); };
  },[initialDraftId,json,userId]);

  async function save() {
    if (!operation || !value || saving) return;
    const checked = structuredRecord.safeParse(value);
    if (!checked.success) { setSaveError("Review the fields before saving.");return; }
    const content = JSON.stringify(structuredDraft.parse({ kind: "structured-draft",schemaVersion: 1,sourceOperationId: operation,value: checked.data }));
    if (content === savedContent) return;
    const abort = new AbortController();setSaving(true);setSaveError("");
    try {
      const input = { title: value.title.trim() || "Untitled structured draft",content,...(draft ? { revision: draft.revision } : {}) };
      const row = savedRecord.parse(await json(draft ? `/api/v1/records/${draft.id}` : "/api/v1/records",abort.signal,input,draft ? "PATCH" : "POST"));
      if (row.content !== content) throw new Error("The saved record did not match the edited fields.");
      if (activeUser.current !== userId) return;
      setDraft({ id: row.id,revision: row.revision });setSavedContent(content);
      History.prototype.replaceState.call(window.history,window.history.state,"",`/structured?draft=${row.id}`);
    } catch (cause) {
      if (activeUser.current === userId) setSaveError(cause instanceof HttpFailure ? cause.message : "Save could not be confirmed. Check your records before trying again.");
    } finally { setSaving(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitted.current || !source.trim()) return;
    submitted.current = true;
    const id = crypto.randomUUID(),abort = new AbortController();controller.current = abort;
    setOperation(id);setPhase("starting");setError("");setValue(undefined);
    History.prototype.replaceState.call(window.history,window.history.state,"",`/structured?id=${id}`);
    try {
      await json("/api/v1/conversations",abort.signal,{ operationId: id,message: source.trim(),mode: "structured-record" });
    } catch (cause) {
      // A rejected request is definitive; a lost response may hide an accepted run.
      if (cause instanceof HttpFailure && cause.status >= 400 && cause.status < 500) {
        History.prototype.replaceState.call(window.history,window.history.state,"","/structured");
        setOperation(undefined);setPhase("idle");setError(cause.message);submitted.current = false;
        return;
      }
    }
    if (!abort.signal.aborted) await check(id,abort.signal);
  }

  async function recover() {
    if (!operation) return;
    controller.current?.abort();const abort = new AbortController();controller.current = abort;
    setError("");setPhase("starting");
    try {
      await replay(operation,abort.signal);
      if (!abort.signal.aborted) await check(operation,abort.signal,false);
    } catch (cause) {
      if (!abort.signal.aborted) { setError(cause instanceof Error ? cause.message : "Recovery failed.");setPhase("failed"); }
    }
  }

  const currentContent = operation && value ? JSON.stringify({ kind: "structured-draft",schemaVersion: 1,sourceOperationId: operation,value }) : undefined;
  const unsaved = currentContent !== undefined && currentContent !== savedContent;
  if (!signedIn) return <main className="mx-auto max-w-2xl p-8"><p role="alert">Your account changed or your session ended.</p><Link href="/login?next=/structured">Sign in again</Link></main>;
  return <main className="mx-auto w-full max-w-2xl space-y-6 p-6 sm:p-10">
    <header><h1 className="text-3xl font-semibold">Structured result</h1><p className="mt-2 text-muted-foreground">Describe material to organize into a title, summary and short list. Review and edit the generated fields before using them.</p></header>
    {phase === "idle" ? <form className="space-y-3" onSubmit={submit}>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <label className="block font-medium" htmlFor="structured-source">Source material</label>
      <textarea id="structured-source" className="min-h-36 w-full rounded-md border bg-background p-3" maxLength={32_000} required value={source} onChange={event => setSource(event.target.value)} placeholder="Describe a topic, meeting or set of notes…" />
      <button className="rounded-md bg-primary px-4 py-2 text-primary-foreground" type="submit">Generate fields</button>
    </form> : null}
    {phase !== "idle" && phase !== "complete" ? <section className="space-y-3">
      <p role="status">{phase === "starting" ? "Confirming the request…" : phase === "running" ? "Generating fields…" : phase === "recovering" ? "Recovering the result…" : phase === "pending" ? "The result is still pending. Check again when ready." : "The result needs attention."}</p>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {(phase === "pending" || phase === "failed") && operation ? <div className="flex gap-3"><button className="rounded border px-3 py-2" onClick={() => { const abort = new AbortController();controller.current = abort;setPhase("starting");setError("");void check(operation,abort.signal); }}>Check status</button><button className="rounded border px-3 py-2" onClick={() => void recover()}>Recover result</button></div> : null}
      <p className="text-sm text-muted-foreground">Checking never sends the request again. You can safely reload this page.</p>
    </section> : null}
    {phase === "complete" && value ? <section className="space-y-4" aria-label="Editable result">
      <p role="status">{draft ? unsaved ? "Unsaved changes to your structured draft." : `Structured draft saved (revision ${draft.revision}).` : "Fields generated. Review and save them below."}</p>
      <label className="block space-y-1">Title<input className="w-full rounded border bg-background p-2" maxLength={120} value={value.title} onChange={event => setValue({ ...value,title: event.target.value })} /></label>
      <label className="block space-y-1">Summary<textarea className="min-h-28 w-full rounded border bg-background p-2" maxLength={2000} value={value.summary} onChange={event => setValue({ ...value,summary: event.target.value })} /></label>
      <div className="space-y-2"><h2 className="font-medium">Items</h2>{value.items.map((item,index) => <div className="flex items-end gap-2" key={index}><label className="block flex-1 space-y-1">Item {index+1}<input className="w-full rounded border bg-background p-2" maxLength={240} value={item} onChange={event => setValue({ ...value,items: value.items.map((entry,i) => i === index ? event.target.value : entry) })} /></label><button className="rounded border px-2 py-2" type="button" onClick={() => setValue({ ...value,items: value.items.filter((_,i) => i !== index) })} aria-label={`Remove item ${index+1}`}>Remove</button></div>)}
        {value.items.length < 8 ? <button className="rounded border px-3 py-2" type="button" onClick={() => setValue({ ...value,items: [...value.items,""] })}>Add item</button> : null}</div>
      <div className="flex items-center gap-3"><button className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50" disabled={saving || !unsaved} onClick={() => void save()}>{saving ? "Saving…" : draft ? "Save changes" : "Save draft"}</button>
        {draft ? <Link className="underline" href="/account">Find in your records</Link> : null}</div>
      {saveError ? <p role="alert" className="text-destructive">{saveError}</p> : null}
    </section> : null}
    {operation || initialDraftId ? <Link className="inline-block underline" href="/structured">New result</Link> : null}
  </main>;
}
