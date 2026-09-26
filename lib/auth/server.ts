import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { authSettings } from "./settings";
import { authFetch, userPrincipal } from "./identity";

export async function currentUser() {
  const settings = authSettings();
  if (!settings) return null;
  const jar = await cookies();
  const client = createServerClient(settings.url, settings.publishableKey, {
    global: { fetch: authFetch },
    cookies: { getAll: () => jar.getAll(), setAll: () => { /* Proxy writes refreshed cookies before rendering. */ } },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) return null;
  userPrincipal(data.user, settings);
  return { id: data.user.id, email: data.user.email ?? "" };
}
