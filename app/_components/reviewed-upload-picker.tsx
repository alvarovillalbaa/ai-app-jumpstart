"use client";

import { useEffect,useRef,useState } from "react";
import { uploadPage,type UploadEntry } from "@/lib/uploads/catalog-contract";
import { MAX_EXTRACTED_TEXT_BYTES,uploadReview } from "@/lib/uploads/review-contract";
import type { ChatUploadReference } from "@/lib/uploads/chat-reference";

async function metadata(path: string,credential: () => Promise<string>,signal: AbortSignal) {
  const token = await credential();
  if (signal.aborted) throw new DOMException("Aborted","AbortError");
  const response = await fetch(path,{ headers: { authorization: `Bearer ${token}` },cache: "no-store",redirect: "error",
    signal: AbortSignal.any([signal,AbortSignal.timeout(15_000)]) });
  const body = await response.json();
  if (signal.aborted) throw new DOMException("Aborted","AbortError");
  if (!response.ok) throw new Error("File review is unavailable. Refresh your files before trying again.");
  return body;
}
/** Metadata only. The server tool independently rechecks ownership and approval before reading. */
export async function validateChatUpload(reference: ChatUploadReference,credential: () => Promise<string>,signal: AbortSignal) {
  const review = uploadReview.parse(await metadata(`/api/v1/uploads/${reference.id}/review`,credential,signal));
  if (review.id !== reference.id || review.status !== "approved" || review.sha256 !== reference.sha256 || review.revision !== reference.reviewRevision) {
    throw new Error("This file review changed. Remove the reference and choose an approved file again.");
  }
}

export function ReviewedUploadPicker({ credential,value,onChange,disabled }: {
  credential: () => Promise<string>;value: ChatUploadReference | null;onChange: (value: ChatUploadReference | null) => void;disabled: boolean;
}) {
  const [items,setItems] = useState<UploadEntry[] | null>(null),[choice,setChoice] = useState("");
  const [busy,setBusy] = useState(false),[error,setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(),[]);
  async function act(select: boolean) {
    controller.current?.abort();const abort = new AbortController();controller.current = abort;
    setBusy(true);setError("");
    try {
      if (!select) {
        setItems(null);setChoice("");
        const page = uploadPage.parse(await metadata("/api/v1/uploads",credential,abort.signal));
        setItems(page.items.filter(item => item.state === "clean" && item.mediaType === "text/plain" && item.size <= MAX_EXTRACTED_TEXT_BYTES));
      } else {
        const item = items?.find(item => item.id === choice);
        if (!item) throw new Error("Choose a file first.");
        const review = uploadReview.parse(await metadata(`/api/v1/uploads/${item.id}/review`,credential,abort.signal));
        if (review.id !== item.id || review.status !== "approved" || review.sha256 !== item.sha256) throw new Error("Approve this file for processing on the Uploads page before choosing it.");
        onChange({ id: item.id,name: item.name,sha256: review.sha256,reviewRevision: review.revision });setItems(null);
      }
    } catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "File review is unavailable."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  }
  return <section aria-label="Reviewed file reference" className="mb-2 max-h-56 space-y-2 overflow-auto rounded border bg-background p-3 text-sm">
    {value ? <div className="flex flex-wrap items-center gap-2">
      <span className="break-all">{value.name} · Review {value.reviewRevision}</span>
      <button type="button" className="rounded border px-2 py-1" disabled={disabled || busy} onClick={() => onChange(null)}>Remove file reference</button>
    </div> : <button type="button" className="rounded border px-3 py-2" disabled={disabled || busy} onClick={() => void act(false)}>{items ? "Refresh files" : "Choose reviewed file"}</button>}
    {items && <>
      <label className="block" htmlFor="reviewed-chat-file">File to reference</label>
      <select id="reviewed-chat-file" className="max-w-full rounded border p-2" disabled={disabled || busy} value={choice} onChange={event => setChoice(event.target.value)}>
        <option value="">Choose a file…</option>
        {items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <button type="button" className="ml-2 rounded border px-3 py-2" disabled={disabled || busy || !choice} onClick={() => void act(true)}>Use file</button>
      {items.length === 0 && <p>No eligible text files. Upload and approve a text file of at most 32 KiB on the Uploads page.</p>}
    </>}
    <p>Only a file reference is sent with your request. The agent asks for approval before reading it. Approved text enters model history.</p>
    {busy && <p role="status">Checking files…</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
