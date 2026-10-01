"use client";

import { createContext,useCallback,useContext,useEffect,useRef,useState } from "react";
import { useTheme } from "next-themes";
import { bind,play,setEnabled,setVolume } from "cuelume";
import { browserAuth } from "@/lib/auth/browser";
import type { PublicAuthSettings } from "@/lib/auth/settings";
import { defaultPreferences,preferences,preferenceValues,type Preferences } from "@/lib/preferences/contract";

type Values = Pick<Preferences,"theme"|"soundEnabled"|"soundVolume">;
type Controls = { value: Preferences;ready: boolean;busy: boolean;account: boolean;error: string;save: (patch: Partial<Values>) => Promise<void>;refresh: () => void;testSound: () => void;captureFeedback: () => () => void };
const context = createContext<Controls|null>(null);
const deviceKey = "jumpstart-device-preferences-v1";
const valuesOf = ({ theme,soundEnabled,soundVolume }: Values): Values => ({ theme,soundEnabled,soundVolume });

export function PreferencesProvider({ children,settings }: { children: React.ReactNode;settings?: PublicAuthSettings|null }) {
  const client = settings ? browserAuth(settings) : null;
  const { setTheme } = useTheme();
  const identity = useRef<string|undefined>(undefined),generation = useRef(0),controller = useRef<AbortController|null>(null);
  const device = useRef<Preferences>({ ...defaultPreferences }),current = useRef<Preferences>({ ...defaultPreferences }),writing = useRef(false);
  const [value,setValue] = useState<Preferences>({ ...defaultPreferences }),[ready,setReady] = useState(false),[busy,setBusy] = useState(false);
  const [account,setAccount] = useState(false),[error,setError] = useState("");

  const apply = useCallback((next: Preferences) => { current.current = next;setValue(next);setTheme(next.theme); },[setTheme]);
  const load = useCallback(async () => {
    if (writing.current) return;
    const id = identity.current;
    if (!id || !client) return;
    controller.current?.abort();const abort = new AbortController();controller.current = abort;
    const version = generation.current;
    setBusy(true);setError("");
    try {
      const { data,error: authError } = await client.auth.getSession();
      if (authError || data.session?.user.id !== id) throw new Error("Your session changed. Sign in again.");
      if (abort.signal.aborted || generation.current !== version || identity.current !== id) return;
      const response = await fetch("/api/v1/account/preferences",{ cache: "no-store",signal: AbortSignal.any([abort.signal,AbortSignal.timeout(15_000)]),headers: { authorization: `Bearer ${data.session.access_token}` } });
      if (!response.ok) throw new Error("Account preferences are unavailable. Try again.");
      const next = preferences.parse(await response.json());
      if (abort.signal.aborted || generation.current !== version || identity.current !== id) return;
      apply(next);setReady(true);
    } catch (cause) { if (!abort.signal.aborted && generation.current === version) setError(cause instanceof Error ? cause.message : "Preferences are unavailable."); }
    finally { if (!abort.signal.aborted && generation.current === version) setBusy(false); }
  },[client,apply]);

  useEffect(() => {
    const initialize = () => {
      setEnabled(false);bind();
      try {
        const stored = localStorage.getItem(deviceKey);
        const legacyTheme = preferenceValues.shape.theme.safeParse(localStorage.getItem("jumpstart-theme"));
        device.current = { ...defaultPreferences,...(stored ? preferenceValues.parse(JSON.parse(stored)) : { theme: legacyTheme.success ? legacyTheme.data : "system" }) };
      } catch { device.current = { ...defaultPreferences }; }
      const change = (id: string) => {
        if (identity.current === id) return;
        // next-themes caches account themes too. Freeze the independent device
        // value before the first account read can change that legacy cache.
        if (id) { try {
          if (localStorage.getItem(deviceKey) === null) localStorage.setItem(deviceKey,JSON.stringify(valuesOf(device.current)));
        } catch { /* Keep the device value in memory if storage is unavailable. */ } }
        generation.current++;identity.current = id;controller.current?.abort();writing.current = false;
        setEnabled(false);setError("");setAccount(Boolean(id));setBusy(Boolean(id));setReady(!id);apply(device.current);
        if (id) void load();
      };
      if (!client) { change("");return () => {}; }
      const { data } = client.auth.onAuthStateChange((_event,session) => {
        const id = session && !session.user.is_anonymous && session.user.role === "authenticated" ? session.user.id : "";
        // Supabase callbacks must return synchronously; start reads outside them.
        queueMicrotask(() => { if (!disposed) change(id); });
      });
      const version = generation.current;
      void client.auth.getSession().then(({ data,error: authError }) => {
        if (disposed || generation.current !== version) return;
        change(!authError && data.session && !data.session.user.is_anonymous && data.session.user.role === "authenticated" ? data.session.user.id : "");
      });
      return () => data.subscription.unsubscribe();
    };
    let disposed = false,unsubscribe = () => {};
    const retire = () => { generation.current++;controller.current?.abort(); };
    const timer = setTimeout(() => { unsubscribe = initialize(); },0);
    return () => { disposed = true;clearTimeout(timer);unsubscribe();retire();setEnabled(false); };
  },[client,load,apply]);

  useEffect(() => { setEnabled(ready && !busy && value.soundEnabled);setVolume(value.soundVolume); },[value.soundEnabled,value.soundVolume,ready,busy]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus",refresh);
    return () => window.removeEventListener("focus",refresh);
  },[load]);

  const save = useCallback(async (patch: Partial<Values>) => {
    if (!ready || busy || writing.current) return;
    const next = preferenceValues.parse({ ...valuesOf(current.current),...patch });
    const id = identity.current;
    if (!id) {
      device.current = { ...defaultPreferences,...next };apply(device.current);
      try { localStorage.setItem(deviceKey,JSON.stringify(next)); } catch { setError("This browser could not save your preferences."); }
      return;
    }
    if (!client) return;
    writing.current = true;setBusy(true);setError("");
    const abort = new AbortController();controller.current?.abort();controller.current = abort;
    const version = generation.current,revision = current.current.revision;
    try {
      const { data,error: authError } = await client.auth.getSession();
      if (authError || data.session?.user.id !== id) throw new Error("Your session changed. Sign in again.");
      if (abort.signal.aborted || generation.current !== version || identity.current !== id) return;
      const response = await fetch("/api/v1/account/preferences",{ method: "PATCH",signal: AbortSignal.any([abort.signal,AbortSignal.timeout(15_000)]),
        headers: { authorization: `Bearer ${data.session.access_token}`,"content-type": "application/json" },body: JSON.stringify({ revision,...patch }) });
      if (!response.ok) throw new Error(response.status === 409 ? "Your preferences changed on another device. Refresh and try again." : "Your preferences could not be saved. Try again.");
      const saved = preferences.parse(await response.json());
      if (abort.signal.aborted || generation.current !== version || identity.current !== id) return;
      apply(saved);
    } catch (cause) { if (!abort.signal.aborted && generation.current === version) setError(cause instanceof Error ? cause.message : "Preferences could not be saved."); }
    finally { if (generation.current === version) { writing.current = false;setBusy(false); } }
  },[ready,busy,client,apply]);

  const captureFeedback = () => {
    const version = generation.current,id = identity.current,enabled = ready && !busy && current.current.soundEnabled;
    return () => {
      if (!enabled || version !== generation.current || id !== identity.current || !current.current.soundEnabled || document.visibilityState !== "visible") return;
      try { play("success"); } catch { /* Browser audio never fails a confirmed action. */ }
    };
  };
  return <context.Provider value={{ value,ready,busy,account,error,save,captureFeedback,refresh: () => { void load(); },testSound: () => {
    if (ready && !busy && current.current.soundEnabled) { try { play("success"); } catch { /* Blocked browser audio never fails the action. */ } }
  } }}>{children}</context.Provider>;
}
export function usePreferences() {
  const value = useContext(context);if (!value) throw new Error("Preferences controls need PreferencesProvider.");return value;
}
const mutedFeedback = () => () => {};
/** Capture permission at the initiating action; account changes invalidate it. */
export function useSoundFeedback() { return useContext(context)?.captureFeedback ?? mutedFeedback; }
