"use client";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PublicAuthSettings } from "./settings";

let cached: { key: string; client: SupabaseClient } | undefined;
export function browserAuth(settings: PublicAuthSettings): SupabaseClient {
  // Client components also render on the server. Never share a client across
  // SSR requests; the browser alone owns the reusable session instance.
  if (typeof window === "undefined") return createBrowserClient(settings.url, settings.publishableKey, { isSingleton: false });
  const key = `${settings.url}:${settings.publishableKey}`;
  if (!cached || cached.key !== key) cached = { key, client: createBrowserClient(settings.url, settings.publishableKey, { isSingleton: false }) };
  return cached.client;
}
