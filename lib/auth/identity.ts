import { createClient, type User } from "@supabase/supabase-js";
import { AppError } from "../http/errors";
import type { Principal } from "../data/service";
import type { PublicAuthSettings } from "./settings";

export function userPrincipal(user: User, settings: PublicAuthSettings): Principal {
  if (!user.id || user.is_anonymous || user.role !== "authenticated") throw new AppError(401, "unauthorized", "Sign in with a registered account.");
  return { tenant: `supabase:${settings.url}`, subject: user.id, scopes: ["records:read", "records:write"] };
}

export const authFetch: typeof fetch = (input, init) => fetch(input, {
  ...init, cache: "no-store", redirect: "error",
  signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
});

/** Framework-neutral: reusable by Next handlers and Eve's independent runtime. */
export async function verifySupabaseToken(token: string, settings: PublicAuthSettings): Promise<Principal> {
  const client = createClient(settings.url, settings.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: authFetch },
  });
  const { data, error } = await client.auth.getUser(token);
  if (error) {
    if (!error.status || error.status >= 500) throw new AppError(503, "identity_unavailable", "Sign-in verification is temporarily unavailable.");
    throw new AppError(401, "unauthorized", "Your session expired. Sign in again.");
  }
  if (!data.user) throw new AppError(401, "unauthorized", "Sign in to continue.");
  return userPrincipal(data.user, settings);
}
