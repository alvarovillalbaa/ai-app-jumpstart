"use client";

import Link from "next/link";
import { useCallback,useEffect,useRef,useState } from "react";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";
import { usageView,type UsageView } from "@/lib/budgets/usage";

function usd(micros: number) {
  return new Intl.NumberFormat(undefined,{ style: "currency",currency: "USD",minimumFractionDigits: 6,maximumFractionDigits: 6 }).format(micros / 1_000_000);
}

export function UsageDashboard({ settings,userId }: { settings: PublicAuthSettings;userId: string }) {
  const client = browserAuth(settings);
  const identity = useRef(userId);
  const controller = useRef<AbortController | null>(null);
  const [signedIn,setSignedIn] = useState(true);
  const [view,setView] = useState<UsageView | null>(null);
  const [busy,setBusy] = useState(true);
  const [error,setError] = useState("");

  useEffect(() => {
    const { data } = client.auth.onAuthStateChange((_event,session) => {
      identity.current = session?.user.id ?? "";
      if (identity.current !== userId) {
        controller.current?.abort();setSignedIn(false);setView(null);
      }
    });
    return () => { data.subscription.unsubscribe();controller.current?.abort(); };
  },[client,userId]);

  const load = useCallback(async () => {
    controller.current?.abort();const abort = new AbortController();controller.current = abort;
    setBusy(true);setError("");setView(null);
    try {
      const { data,error } = await client.auth.getSession();
      if (error || !data.session || data.session.user.id !== userId || identity.current !== userId) throw new Error("Your account changed or your session expired. Sign in again.");
      const response = await fetch("/api/v1/usage",{
        cache: "no-store",signal: AbortSignal.any([abort.signal,AbortSignal.timeout(15_000)]),
        headers: { authorization: `Bearer ${data.session.access_token}` },
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error?.message ?? "AI usage is unavailable. Try again.");
      const next = usageView.parse(body);
      if (!abort.signal.aborted && identity.current === userId) setView(next);
    } catch (error) {
      if (!abort.signal.aborted && identity.current === userId) setError(error instanceof Error ? error.message : "AI usage is unavailable.");
    } finally { if (!abort.signal.aborted) setBusy(false); }
  },[client,userId]);

  useEffect(() => {
    const timer = setTimeout(() => { void load(); },0);
    return () => { clearTimeout(timer);controller.current?.abort(); };
  },[load]);

  if (!signedIn) return <main className="p-8"><p role="alert">Your account changed or your session ended.</p><Link href="/login?next=/usage">Sign in again</Link></main>;
  const used = view ? view.chargedMicros + view.reservedMicros : 0;
  return <main className="mx-auto max-w-3xl space-y-6 p-6 sm:p-8">
    <h1 className="text-3xl font-medium">AI usage</h1>
    <p className="text-muted-foreground">Your current UTC-day budget snapshot. It is an application limit, not a provider invoice.</p>
    <button className="rounded border px-3 py-2" disabled={busy} onClick={() => void load()}>Refresh</button>
    {error && <p role="alert">{error}</p>}
    {busy && <p role="status">Loading…</p>}
    {view && <section className="space-y-5" aria-label="Current AI usage">
      <p className="font-medium">UTC day {new Date(view.day * 86_400_000).toISOString().slice(0,10)}</p>
      <div>
        <label htmlFor="daily-budget" className="block">Charged plus reserved: {usd(used)} of {usd(view.dailyLimitMicros)}</label>
        <progress id="daily-budget" className="mt-2 w-full" max={view.dailyLimitMicros} value={Math.min(used,view.dailyLimitMicros)} />
      </div>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div><dt className="text-muted-foreground">Charged today</dt><dd className="font-medium">{usd(view.chargedMicros)}</dd></div>
        <div><dt className="text-muted-foreground">Reserved for pending work</dt><dd className="font-medium">{usd(view.reservedMicros)}</dd></div>
        <div><dt className="text-muted-foreground">Active reservations</dt><dd className="font-medium">{view.active}</dd></div>
        <div><dt className="text-muted-foreground">Requests in the last minute</dt><dd className="font-medium">{view.recent}</dd></div>
        <div><dt className="text-muted-foreground">Unknown-cost settlements</dt><dd className="font-medium">{view.unknownCosts}</dd></div>
      </dl>
      <p className="text-sm text-muted-foreground">Unknown costs conservatively charge the reserved estimate. Active reservations can include work started on an earlier UTC day. Refresh to see later settlements.</p>
    </section>}
  </main>;
}
