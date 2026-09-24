"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";
import { operationId, sessionId } from "@/lib/agent-access/contract";
import { AgentChat } from "./agent-chat";

const receipt = z.discriminatedUnion("status", [
  z.object({ operationId, conversationId: z.uuid(), status: z.literal("starting"), sessionId: z.null() }),
  z.object({ operationId, conversationId: z.uuid(), status: z.literal("active"), sessionId }),
]);

export function OwnedChat({ settings, userId, initialOperationId }: {
  settings: PublicAuthSettings; userId: string; initialOperationId?: string;
}) {
  const client = browserAuth(settings);
  const activeUser = useRef(userId);
  const [signedIn, setSignedIn] = useState(true);
  const [operation, setOperation] = useState(initialOperationId);
  const [session, setSession] = useState<string>();
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(Boolean(initialOperationId));
  const [canCancel, setCanCancel] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const submission = useRef(false);

  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event, current) => {
      activeUser.current = current?.user.id ?? "";
      if (activeUser.current !== userId) {
        controller.current?.abort();
        setSignedIn(false); // Unmount the transcript and its stream on identity change.
      }
    });
    return () => { data.subscription.unsubscribe(); controller.current?.abort(); };
  }, [client, userId]);

  const credential = useCallback(async () => {
    const { data, error } = await client.auth.getSession();
    if (error || !data.session || data.session.user.id !== userId || activeUser.current !== userId) throw new Error("Your account changed or your session expired. Sign in again.");
    return data.session.access_token;
  }, [client, userId]);

  const check = useCallback(async (id: string, signal: AbortSignal) => {
    const deadline = Date.now() + 60_000;
    try {
      do {
        const token = await credential();
        const response = await fetch(`/api/v1/conversations/${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${token}` }, cache: "no-store",
          signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
        const body = await response.json();
        if (response.status === 404 && body.error?.code === "conversation_not_found" && !signal.aborted) setCanCancel(true);
        if (!response.ok) throw new Error(body.error?.message ?? "Conversation status is unavailable.");
        const value = receipt.parse(body);
        if (value.operationId !== id) throw new Error("Unexpected conversation response.");
        if (signal.aborted || activeUser.current !== userId) return;
        if (value.status === "active") { setSession(value.sessionId); return; }
        setCanCancel(true);
        // Status reads only. An ambiguous creation is never resubmitted.
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, 1000);
          signal.addEventListener("abort", done, { once: true });
        });
      } while (!signal.aborted && Date.now() < deadline);
    } catch (error) {
      if (!signal.aborted && activeUser.current === userId) setError(error instanceof Error ? error.message : "Conversation status is unavailable.");
    } finally { if (!signal.aborted) setChecking(false); }
  }, [credential, userId]);

  useEffect(() => {
    if (!initialOperationId) return;
    const abort = new AbortController(); controller.current = abort;
    // A cancellable scheduled poll also avoids dispatch during Strict Mode's
    // discarded first mount. State updates belong to the async poll callback.
    const timer = setTimeout(() => { void check(initialOperationId, abort.signal); }, 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [initialOperationId, check]);

  async function create(message: string) {
    if (submission.current) return;
    submission.current = true;
    const id = crypto.randomUUID();
    const abort = new AbortController(); controller.current = abort;
    setOperation(id); setChecking(true); setCanCancel(false); setCancelled(false); setError("");
    // Persist only the operation locator before dispatch. Reload never creates a second run.
    History.prototype.replaceState.call(window.history, window.history.state, "", `/s/${id}`);
    try {
      const token = await credential();
      const response = await fetch("/api/v1/conversations", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ message, operationId: id }),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]),
      });
      const body = await response.json();
      if (!response.ok) {
        if (!abort.signal.aborted) { setError(body.error?.message ?? "Conversation could not be started."); setChecking(false); }
        return;
      }
      const value = receipt.parse(body);
      if (value.operationId !== id) throw new Error("Unexpected conversation response.");
      if (abort.signal.aborted || activeUser.current !== userId) return;
      if (value.status === "active") { setSession(value.sessionId); setChecking(false); return; }
      setCanCancel(true);
    } catch {
      // The server may already have accepted this request. Recover by reading its locator.
    }
    if (!abort.signal.aborted) await check(id, abort.signal);
  }

  async function cancelStart(id: string) {
    if (!canCancel || cancelling) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    setCancelling(true); setChecking(false); setError("");
    try {
      const token = await credential();
      const response = await fetch(`/api/v1/conversations/${encodeURIComponent(id)}/cancel-start`, {
        method: "POST", headers: { authorization: `Bearer ${token}` }, cache: "no-store",
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "Pending start could not be cancelled.");
      if (body.status !== "cancelled" || body.operationId !== id) throw new Error("Unexpected cancellation response.");
      if (abort.signal.aborted || activeUser.current !== userId) return;
      History.prototype.replaceState.call(window.history, window.history.state, "", "/s");
      submission.current = false;
      setOperation(undefined); setSession(undefined); setCanCancel(false); setCancelled(true);
    } catch (error) {
      if (!abort.signal.aborted && activeUser.current === userId) setError(error instanceof Error ? error.message : "Pending start could not be cancelled.");
    } finally { if (!abort.signal.aborted) setCancelling(false); }
  }

  if (!signedIn) return <main className="p-8"><p role="alert">Your account changed or your session ended.</p><Link href="/login?next=/s">Sign in again</Link></main>;
  if (cancelled) return <main className="mx-auto max-w-xl space-y-4 p-8">
    <h1 className="text-2xl font-medium">Pending start cancelled</h1>
    <p>No runtime claimed this conversation. Its reserved budget has been released.</p>
    <button className="rounded border px-3 py-2" onClick={() => setCancelled(false)}>New chat</button>
    <Link className="ml-4 underline" href="/conversations">Conversations</Link>
  </main>;
  if (operation && !session) return <main className="mx-auto max-w-xl space-y-4 p-8">
    <h1 className="text-2xl font-medium">Starting your conversation</h1>
    <p role="status">{checking ? "Waiting for the runtime to confirm your conversation…" : "Your conversation has not been confirmed. You can check its status again."}</p>
    {error && <p role="alert">{error}</p>}
    <button className="rounded border px-3 py-2" disabled={checking} onClick={() => {
      setChecking(true); setError("");
      controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
      void check(operation, abort.signal);
    }}>Check status</button>
    {canCancel && <button className="ml-3 rounded border px-3 py-2" disabled={cancelling} onClick={() => void cancelStart(operation)}>{cancelling ? "Cancelling…" : "Cancel pending start"}</button>}
    <p>Checking status does not send your message again. Cancelling succeeds only before the runtime claims the conversation.</p>
    <Link className="underline" href="/s" onNavigate={() => {
      // Reset even when Next still considers this its original /s route.
      controller.current?.abort(); submission.current = false;
      setOperation(undefined); setSession(undefined); setChecking(false); setCanCancel(false); setError("");
    }}>New chat</Link><Link className="ml-4 underline" href="/conversations">Conversations</Link>
  </main>;
  return <AgentChat key={session ?? "new"} sessionId={session} sessionless managed credential={credential} onCreate={create} />;
}
