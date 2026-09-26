"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";
import { DEFAULT_UPLOAD_QUOTA, uploadEntry, uploadPage, type UploadEntry } from "@/lib/uploads/catalog-contract";
import { MAX_API_UPLOAD_BYTES, uploadName, type UploadMediaType } from "@/lib/uploads/schema";

type Props = { settings?: PublicAuthSettings; userId?: string; downloadEnabled?: boolean };
type Page = ReturnType<typeof uploadPage.parse>;
const extensions: Record<string, UploadMediaType> = {
  txt: "text/plain", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", pdf: "application/pdf",
};
const buttonClass = "rounded border px-3 py-2 disabled:opacity-50";

function messageFrom(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "error" in body) {
    const error = body.error;
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  }
  return fallback;
}

function checkedFile(file: File): { name: string; mediaType: UploadMediaType } {
  const name = uploadName.parse(file.name);
  const mediaType = extensions[name.split(".").pop()?.toLowerCase() ?? ""];
  if (!mediaType) throw new Error("Choose a .txt, .png, .jpg, .jpeg or .pdf file.");
  if (!file.size || file.size > MAX_API_UPLOAD_BYTES) throw new Error("Choose a file between 1 byte and 4 MiB.");
  return { name, mediaType };
}

export function UploadQuarantine({ settings, userId, downloadEnabled = false }: Props) {
  const client = settings ? browserAuth(settings) : null;
  const identity = useRef(userId ?? "");
  const generation = useRef(0);
  const listController = useRef<AbortController | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  const uploadRequest = useRef<XMLHttpRequest | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [token, setToken] = useState("");
  const [connected, setConnected] = useState(Boolean(settings));
  const [signedIn, setSignedIn] = useState(true);
  const [page, setPage] = useState<Page | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [acting, setActing] = useState<{ id: string;kind: "scan" | "download" | "delete" } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const credential = useCallback(async () => {
    if (!client) return token;
    const { data, error } = await client.auth.getSession();
    if (error || !data.session || data.session.user.id !== userId || identity.current !== userId) {
      throw new Error("Your account changed or your session expired. Sign in again.");
    }
    return data.session.access_token;
  }, [client, token, userId]);

  const load = useCallback(async () => {
    const current = generation.current;
    listController.current?.abort();
    const controller = new AbortController(); listController.current = controller;
    setBusy(true); setError("");
    try {
      const accessToken = await credential();
      if (current !== generation.current || controller.signal.aborted) return;
      const response = await fetch("/api/v1/uploads", {
        cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(messageFrom(body, `Uploads are unavailable (${response.status}).`));
      const result = uploadPage.parse(body);
      if (current === generation.current && !controller.signal.aborted) { setPage(result); setConnected(true); }
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Uploads are unavailable.");
    } finally { if (current === generation.current && !controller.signal.aborted) setBusy(false); }
  }, [credential]);

  useEffect(() => {
    if (!client) return;
    const generationRef = generation;
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      identity.current = session?.user.id ?? "";
      if (identity.current !== userId) {
        generation.current++;
        listController.current?.abort(); downloadController.current?.abort(); uploadRequest.current?.abort();
        setSignedIn(false); setPage(null); setFile(null); setBusy(false); setUploading(false);
      }
    });
    const timer = setTimeout(() => { void load(); }, 0);
    return () => { clearTimeout(timer); data.subscription.unsubscribe(); generationRef.current++; listController.current?.abort(); downloadController.current?.abort(); uploadRequest.current?.abort(); };
  }, [client, load, userId]);

  function disconnect() {
    generation.current++;
    listController.current?.abort(); downloadController.current?.abort(); uploadRequest.current?.abort();
    if (fileInput.current) fileInput.current.value = "";
    setToken(""); setConnected(false); setPage(null); setFile(null); setError(""); setNotice(""); setBusy(false); setUploading(false); setActing(null);
  }

  async function upload() {
    if (!file) return;
    const current = generation.current;
    setError(""); setNotice(""); setProgress(0);
    let selected: ReturnType<typeof checkedFile>;
    try { selected = checkedFile(file); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Invalid file."); return; }
    setUploading(true);
    try {
      const accessToken = await credential();
      if (current !== generation.current) return;
      const row = await new Promise<UploadEntry>((resolve, reject) => {
        const request = new XMLHttpRequest(); uploadRequest.current = request;
        request.open("POST", "/api/v1/uploads"); request.timeout = 30_000;
        request.setRequestHeader("authorization", `Bearer ${accessToken}`);
        request.setRequestHeader("content-type", "application/octet-stream");
        request.setRequestHeader("x-upload-name", encodeURIComponent(selected.name));
        request.setRequestHeader("x-upload-media-type", selected.mediaType);
        request.upload.onprogress = event => { if (event.lengthComputable && current === generation.current) setProgress(Math.round(event.loaded / event.total * 100)); };
        request.onload = () => {
          let body: unknown;
          try { body = JSON.parse(request.responseText); } catch { body = null; }
          if (request.status !== 201) reject(new Error(messageFrom(body, `Upload failed (${request.status}).`)));
          else { try { resolve(uploadEntry.parse(body)); } catch { reject(new Error("Upload response was invalid. Refresh before retrying.")); } }
        };
        request.onerror = () => reject(new Error("Upload connection failed. Refresh before retrying."));
        request.ontimeout = () => reject(new Error("Upload timed out. Refresh before retrying; it may have completed."));
        request.onabort = () => reject(new Error("Upload cancelled. Refresh before retrying; it may have completed."));
        request.send(file);
      });
      if (current !== generation.current) return;
      if (fileInput.current) fileInput.current.value = "";
      setFile(null); setNotice(`“${row.name}” is quarantined. ${downloadEnabled ? "An owner download requires a fresh clean scanner verdict." : "It cannot be downloaded or used by the agent."}`);
      await load();
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : "Upload failed.");
    } finally {
      if (current === generation.current) { uploadRequest.current = null; setUploading(false); }
    }
  }

  async function remove(item: UploadEntry) {
    if (!window.confirm(`Delete “${item.name}” from private storage? This cannot be undone.`)) return;
    const current = generation.current;
    setActing({ id: item.id,kind: "delete" }); setError(""); setNotice("");
    try {
      const accessToken = await credential();
      if (current !== generation.current) return;
      const response = await fetch(`/api/v1/uploads/${item.id}`, {
        method: "DELETE", cache: "no-store", signal: AbortSignal.timeout(15_000),
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (response.status !== 204) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(messageFrom(body, `Delete failed (${response.status}).`));
      }
      if (current !== generation.current) return;
      setNotice(`“${item.name}” was deleted.`); await load();
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : "Delete failed.");
    } finally { if (current === generation.current) setActing(null); }
  }

  async function download(item: UploadEntry) {
    const current = generation.current,controller = new AbortController();
    downloadController.current = controller;
    setActing({ id: item.id,kind: "download" });setError("");setNotice("");
    try {
      const accessToken = await credential();
      if (current !== generation.current || controller.signal.aborted) return;
      const response = await fetch(`/api/v1/uploads/${item.id}/download`,{
        cache: "no-store",signal: AbortSignal.any([controller.signal,AbortSignal.timeout(60_000)]),
        headers: { authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        throw new Error(messageFrom(body,`Download failed (${response.status}).`));
      }
      if (response.headers.get("content-type")?.split(";")[0] !== "application/octet-stream") throw new Error("Download response was invalid.");
      const blob = await response.blob();
      if (blob.size !== item.size || current !== generation.current || controller.signal.aborted) throw new Error("Download was interrupted or changed.");
      const url = URL.createObjectURL(blob),anchor = document.createElement("a");
      anchor.href = url;anchor.download = item.name;anchor.style.display = "none";
      document.body.append(anchor);anchor.click();anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url),60_000);
      setNotice(`“${item.name}” passed a fresh scan and was downloaded.`);
      await load();
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted) {
        await load();
        if (current === generation.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Download failed.");
      }
    } finally {
      if (downloadController.current === controller) downloadController.current = null;
      if (current === generation.current) setActing(null);
    }
  }

  async function scan(item: UploadEntry) {
    const current = generation.current,controller = new AbortController();
    downloadController.current = controller;
    setActing({ id: item.id,kind: "scan" });setError("");setNotice("");
    try {
      const accessToken = await credential();
      if (current !== generation.current || controller.signal.aborted) return;
      const response = await fetch(`/api/v1/uploads/${item.id}/scan`,{
        method: "POST",body: "{}",cache: "no-store",signal: AbortSignal.any([controller.signal,AbortSignal.timeout(60_000)]),
        headers: { authorization: `Bearer ${accessToken}`,"content-type": "application/json" },
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(messageFrom(body,`Scan failed (${response.status}).`));
      const row = uploadEntry.parse(body);
      if (row.id !== item.id || row.state !== "clean") throw new Error("Scan response was invalid. Refresh its status.");
      if (current !== generation.current || controller.signal.aborted) return;
      setNotice(`“${item.name}” passed a malware scan. Each download is scanned again.`);
      await load();
    } catch (cause) {
      if (current === generation.current && !controller.signal.aborted) {
        await load();
        if (current === generation.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Scan failed.");
      }
    } finally {
      if (downloadController.current === controller) downloadController.current = null;
      if (current === generation.current) setActing(null);
    }
  }

  if (!signedIn) return <main className="p-8"><p role="alert">Your account changed or your session ended.</p><Link href="/login?next=/uploads">Sign in again</Link></main>;
  return <main className="mx-auto max-w-3xl space-y-6 p-6 sm:p-8">
    <h1 className="text-3xl font-medium">Private uploads</h1>
    <p className="text-muted-foreground">{downloadEnabled
      ? "Store files in private quarantine. Owner downloads require a fresh clean scan; files cannot be previewed or used by the agent."
      : "Store files in private quarantine. Files cannot be downloaded, previewed or used by the agent until scanning and release are available."}</p>
    {!connected ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void load(); }}>
      <label className="block">Access token<input className="mt-1 w-full rounded border bg-background p-2" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} minLength={32} required /></label>
      <p className="text-sm text-muted-foreground">Use a credential with upload access. It stays in this tab’s memory.</p>
      <button className={buttonClass} disabled={busy} type="submit">Connect</button>
    </form> : <>
      <div className="flex flex-wrap gap-3"><button className={buttonClass} disabled={busy || uploading || acting !== null} onClick={() => void load()}>Refresh</button>{!settings && <button className={buttonClass} onClick={disconnect}>Disconnect</button>}</div>
      <section className="space-y-3 rounded border p-4" aria-labelledby="upload-heading">
        <h2 id="upload-heading" className="text-lg font-medium">Add a file</h2>
        <p className="text-sm text-muted-foreground">UTF-8 text, PNG, JPEG or PDF. Maximum 4 MiB per file. The server checks the actual bytes.</p>
        <label className="block">File<input ref={fileInput} className="mt-1 block w-full text-sm" type="file" accept=".txt,.png,.jpg,.jpeg,.pdf" disabled={uploading} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(""); setNotice(""); }} /></label>
        <div className="flex flex-wrap items-center gap-3"><button className={buttonClass} disabled={!file || uploading || acting !== null} onClick={() => void upload()}>Upload to quarantine</button>
          {uploading && <button className={buttonClass} onClick={() => uploadRequest.current?.abort()}>Cancel upload</button>}</div>
        {uploading && <div role="status"><label htmlFor="upload-progress">Uploading {progress}%</label><progress id="upload-progress" className="ml-3" value={progress} max="100" /></div>}
      </section>
      {page && <section aria-labelledby="stored-heading" className="space-y-3">
        <h2 id="stored-heading" className="text-lg font-medium">Stored files</h2>
        <p className="text-sm text-muted-foreground">{page.usage.files} of {DEFAULT_UPLOAD_QUOTA.maxFiles} files · {(page.usage.bytes / 1024 / 1024).toFixed(2)} of {DEFAULT_UPLOAD_QUOTA.maxBytes / 1024 / 1024} MiB reserved</p>
        {!page.items.length ? <p>No uploads yet.</p> : <ul className="divide-y">{page.items.map(item => <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0"><h3 className="break-words font-medium">{item.name}</h3><p className="text-sm text-muted-foreground">{item.state === "clean" ? downloadEnabled ? "Last scan passed · each download is scanned again" : "Last scan passed · downloads disabled on this host" : item.state === "rejected" ? item.scan?.status === "rejected" && item.scan.reason === "integrity" ? "Rejected · stored bytes failed validation" : "Rejected · malware scan failed" : item.state === "quarantined" ? downloadEnabled ? "Quarantined · scan required for each owner download" : "Quarantined · unavailable for download or agent use" : item.state === "deleting" ? "Deletion pending · retry deletion" : "Storage pending · unavailable for use"} · {(item.size / 1024).toFixed(1)} KiB · {new Date(item.createdAt).toLocaleString()}</p>
            {item.scan && <p className="text-sm text-muted-foreground">Last checked {new Date(item.scan.checkedAt).toLocaleString()}</p>}</div>
          <div className="flex flex-wrap gap-2">{downloadEnabled && (item.state === "quarantined" || item.state === "clean") && <>
            <button className={buttonClass} disabled={uploading || acting !== null} onClick={() => void scan(item)}>{item.state === "clean" ? "Scan again" : "Scan file"}</button>
            <button className={buttonClass} disabled={uploading || acting !== null} onClick={() => void download(item)}>Download after scan</button></>}
            <button className={buttonClass} disabled={uploading || acting !== null} onClick={() => void remove(item)}>{item.state === "deleting" ? "Retry deletion" : "Delete"}</button></div>
        </li>)}</ul>}
      </section>}
    </>}
    {notice && <p role="status">{notice}</p>}
    {acting && <p role="status">{acting.kind === "scan" ? "Scanning file…" : acting.kind === "download" ? "Scanning file for download…" : "Deleting file…"}</p>}
    {busy && <p role="status">Loading uploads…</p>}
    {error && <p role="alert" className="text-destructive">{error}</p>}
  </main>;
}
