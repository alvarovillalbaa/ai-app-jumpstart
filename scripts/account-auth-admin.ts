import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { trustedHttpOrigin } from "../lib/security/origin";

function operatorAuthKey(value: string) {
  if (value.startsWith("sb_secret_") && value.length >= 24) return true;
  try {
    const parts = value.split(".");
    return parts.length === 3 && JSON.parse(Buffer.from(parts[1],"base64url").toString()).role === "service_role";
  } catch { return false; }
}

/** Validate the exact Auth owner and return a narrowly configured admin client. */
export function supabaseAuthAdmin(ownerInput: AccessOwner,env: Record<string,string | undefined>,request: typeof fetch = fetch) {
  const owner = accessOwner.parse(ownerInput),origin = trustedHttpOrigin(env.SUPABASE_AUTH_URL ?? env.SUPABASE_URL);
  const key = env.SUPABASE_AUTH_ADMIN_KEY ?? "";
  if (env.AUTH_PROVIDER !== "supabase" || !origin || owner.tenant !== `supabase:${origin}` ||
      !z.uuid().safeParse(owner.subject).success || !operatorAuthKey(key))
    throw new Error("Auth origin, owner or operator credential is invalid.");
  const auth = createClient(origin,key,{ auth: { persistSession: false,autoRefreshToken: false,detectSessionInUrl: false },
    global: { fetch: (input,init) => request(input,{ ...init,cache: "no-store",redirect: "error",
      signal: init?.signal ? AbortSignal.any([init.signal,AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) }) } }).auth.admin;
  return { origin,auth };
}
