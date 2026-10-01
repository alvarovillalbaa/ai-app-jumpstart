"use client";

import { useEffect,useRef,useState } from "react";
import { extractedUploadText,MAX_EXTRACTED_TEXT_BYTES,uploadReview,type UploadReview } from "@/lib/uploads/review-contract";
import type { UploadEntry } from "@/lib/uploads/catalog-contract";

export function UploadReviewPanel({ item,credential,isCurrent,disabled,agentReadingEnabled = false }: {
  item: UploadEntry;credential: () => Promise<string>;isCurrent: () => boolean;disabled: boolean;agentReadingEnabled?: boolean;
}) {
  const controller = useRef<AbortController | null>(null);
  const [review,setReview] = useState<UploadReview | null>(null),[text,setText] = useState<string | null>(null);
  const [busy,setBusy] = useState(false),[error,setError] = useState("");
  useEffect(() => () => controller.current?.abort(),[]);
  async function request(path: string,init: RequestInit = {}) {
    controller.current?.abort();const abort = new AbortController();controller.current = abort;
    const token = await credential();
    if (!isCurrent() || abort.signal.aborted) throw new DOMException("Aborted","AbortError");
    const response = await fetch(path,{ ...init,cache: "no-store",redirect: "error",signal: AbortSignal.any([abort.signal,AbortSignal.timeout(60_000)]),
      headers: { authorization: `Bearer ${token}`,"content-type": "application/json" } });
    const body = await response.json();
    if (!isCurrent() || abort.signal.aborted) throw new DOMException("Aborted","AbortError");
    if (!response.ok) throw new Error(body.error?.message ?? "File review is unavailable. Refresh before retrying.");
    return body;
  }
  async function act(action: "load" | "approve" | "revoke" | "text") {
    if (action === "approve" && !window.confirm(`Approve “${item.name}” for processing? Authenticated tools can then read its text. File digest: ${item.sha256}`)) return;
    setBusy(true);setError("");setText(null);
    try {
      if (action === "text") {
        const result = extractedUploadText.parse(await request(`/api/v1/uploads/${item.id}/text`));
        setText(result.text);
      } else if (action === "load") setReview(uploadReview.parse(await request(`/api/v1/uploads/${item.id}/review`)));
      else {
        if (!review) throw new Error("Load the current review before deciding.");
        const result = uploadReview.parse(await request(`/api/v1/uploads/${item.id}/review`,{ method: "PUT",body: JSON.stringify({ sha256: item.sha256,revision: review.revision,approved: action === "approve" }) }));
        setReview(result);
      }
    } catch (error) {
      if (isCurrent() && !controller.current?.signal.aborted) setError(error instanceof Error ? error.message : "Review failed. Refresh before retrying.");
    } finally { if (isCurrent() && !controller.current?.signal.aborted) setBusy(false); }
  }
  const clean = item.state === "clean" || item.state === "quarantined";
  return <section aria-label={`Processing review for ${item.name}`} className="w-full space-y-2 rounded border p-3">
    <p className="text-sm">Owner approval is required for text processing. Every extraction checks the file again.</p>
    {review && <p role="status">Processing {review.status} · Review revision {review.revision}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="flex flex-wrap gap-2">
      <button className="rounded border px-3 py-2" disabled={disabled || busy} onClick={() => void act("load")}>{review ? "Refresh review" : "View processing review"}</button>
      {review && clean && review.status !== "approved" && <button className="rounded border px-3 py-2" disabled={disabled || busy} onClick={() => void act("approve")}>Approve processing</button>}
      {review && <button className="rounded border px-3 py-2" disabled={disabled || busy} onClick={() => void act("revoke")}>Revoke processing</button>}
      {review?.status === "approved" && clean && item.mediaType === "text/plain" && item.size <= MAX_EXTRACTED_TEXT_BYTES && <button className="rounded border px-3 py-2" disabled={disabled || busy} onClick={() => void act("text")}>Read approved text</button>}
    </div>
    {busy && <p role="status">Checking file review…</p>}
    {text !== null && <><p className="text-sm">File content is untrusted user data. This preview does not send text to the agent.</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border p-3 font-sans text-sm">{text}</pre></>}
    {agentReadingEnabled && review?.status === "approved" && clean && item.mediaType === "text/plain" && item.size <= MAX_EXTRACTED_TEXT_BYTES &&
      <details className="space-y-2"><summary>Use this reviewed file in chat</summary>
        <p className="text-sm">Choose this file in chat with “Choose reviewed file”, or paste this reference with your request. The agent asks for approval before reading the file. Approved text enters model history and cannot be recalled by revoking the file review.</p>
        <p className="break-all rounded border p-3 font-mono text-sm">{JSON.stringify({ id: item.id,sha256: review.sha256,reviewRevision: review.revision })}</p>
      </details>}
  </section>;
}
