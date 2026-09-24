import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authSettings } from "./settings";
import { authFetch } from "./identity";

export async function refreshSession(request: NextRequest) {
  const settings = authSettings();
  if (!settings) return NextResponse.next({ request });
  let response = NextResponse.next({ request });
  const client = createServerClient(settings.url, settings.publishableKey, {
    global: { fetch: authFetch },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values, headers) {
        values.forEach(({ name, value }) => request.cookies.set(name, value));
        const previous = response;
        response = NextResponse.next({ request });
        previous.cookies.getAll().forEach(cookie => response.cookies.set(cookie));
        previous.headers.forEach((value, name) => { if (["cache-control", "expires", "pragma"].includes(name)) response.headers.set(name, value); });
        values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
      },
    },
  });
  await client.auth.getUser();
  // All account/auth responses remain private even if no refresh was necessary.
  response.headers.set("cache-control", "private, no-store");
  response.headers.set("referrer-policy", "no-referrer");
  return response;
}
