"use client";
import { useEffect,useState } from "react";
import { usePreferences } from "./preferences-provider";

export function SoundPreferences() {
  const p = usePreferences();
  const [volume,setVolume] = useState(p.value.soundVolume);
  useEffect(() => { const timer = setTimeout(() => setVolume(p.value.soundVolume),0);return () => clearTimeout(timer); },[p.value.soundVolume]);
  return <section aria-label="Sound preferences" className="space-y-3 rounded-md border p-4">
    <h2 className="text-lg font-medium">Sound feedback</h2>
    <p className="text-sm text-muted-foreground">Optional sounds for confirmed actions. Visual feedback stays available.</p>
    <label className="flex items-center gap-2"><input type="checkbox" checked={p.value.soundEnabled} disabled={!p.ready || p.busy} onChange={event => { void p.save({ soundEnabled: event.target.checked }); }} />Enable sounds</label>
    <label className="flex items-center gap-3">Sound volume<input type="range" min="0" max="1" step="0.05" value={volume} disabled={!p.ready || p.busy} onChange={event => setVolume(Number(event.target.value))} /></label>
    <button className="rounded border px-3 py-2" disabled={!p.ready || p.busy || volume === p.value.soundVolume} onClick={() => { void p.save({ soundVolume: volume }); }}>Save volume</button>
    <button className="rounded border px-3 py-2" disabled={!p.ready || p.busy || !p.value.soundEnabled} onClick={p.testSound}>Test sound</button>
    <p className="text-sm text-muted-foreground">{p.account ? "Changes are saved to your account across devices." : "Changes are saved on this device."}</p>
    {p.busy && <p role="status">Updating preferences…</p>}
    {p.error && <p role="alert">{p.error}</p>}
    {p.account && <button className="rounded border px-3 py-2" disabled={p.busy} onClick={p.refresh}>Refresh preferences</button>}
  </section>;
}
