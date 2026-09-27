import { createClient } from "@supabase/supabase-js";
import type { Database } from "../data/supabase.generated";
import { preferences,preferenceOwner,preferencePatch,type PreferenceStore } from "./contract";

export function supabasePreferenceStore(url: string,secret: string): PreferenceStore {
  const client = createClient<Database>(url,secret,{ auth: { persistSession: false,autoRefreshToken: false },global: {
    fetch: (input,init) => fetch(input,{ ...init,redirect: "error",signal: AbortSignal.timeout(10_000) }),
  } });
  return {
    async get(owner) {
      const o = preferenceOwner.parse(owner),{ data,error } = await client.rpc("app_preferences_command",{ command: "get",input: o });
      if (error) throw error;return preferences.parse(data);
    },
    async update(owner,input) {
      const o = preferenceOwner.parse(owner),patch = preferencePatch.parse(input),{ data,error } = await client.rpc("app_preferences_command",{ command: "update",input: { ...o,patch } });
      if (error) throw error;return preferences.nullable().parse(data);
    },
    async close() {},
  };
}
