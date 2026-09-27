"use client";

import { useSyncExternalStore } from "react";
import { usePreferences } from "./preferences-provider";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function ThemeSelector() {
  const p = usePreferences();
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return <><label className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm">
    Theme
    <select aria-label="Theme" className="rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      disabled={!mounted || !p.ready || p.busy} value={mounted ? p.value.theme : "system"} onChange={event => { void p.save({ theme: event.target.value as "system"|"light"|"dark" }); }}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>
    {p.error && <div className="px-3 pb-2 text-xs"><p>{p.error}</p>{p.account && <button className="mt-1 underline" disabled={p.busy} onClick={p.refresh}>Refresh theme</button>}</div>}
  </>;
}
