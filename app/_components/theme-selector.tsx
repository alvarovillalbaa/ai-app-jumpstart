"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";

const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function ThemeSelector() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
  return <label className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm">
    Theme
    <select aria-label="Theme" className="rounded-md border bg-background px-2 py-1 text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      disabled={!mounted} value={mounted ? theme ?? "system" : "system"} onChange={event => setTheme(event.target.value)}>
      <option value="system">System</option>
      <option value="light">Light</option>
      <option value="dark">Dark</option>
    </select>
  </label>;
}
