import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authSettings, safeReturnPath } from "./settings";
import { authFetch } from "./identity";
import { config } from "../config";
import { handle, readJson } from "../http/handler";
import { AppError } from "../http/errors";
import { z } from "zod";

function callbackClient(request: NextRequest, response: NextResponse) {
  const settings = authSettings();
  if (!settings) throw new AppError(503, "auth_unconfigured", "Account sign-in is not configured.");
  return createServerClient(settings.url, settings.publishableKey, {
    global: { fetch: authFetch },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values, headers) {
        values.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
      },
    },
  });
}

const confirmation = z.object({ token_hash: z.string().min(1).max(2048), type: z.enum(["email", "recovery"]), next: z.string().optional() }).strict();
export function confirmEmail(request: NextRequest) {
  return handle(request, async () => {
    if (request.headers.get("origin") !== new URL(config().APP_ORIGIN).origin) throw new AppError(403, "origin_rejected", "Open this confirmation from the application.");
    const input = confirmation.parse(await readJson(request));
    const next = input.type === "recovery" ? "/account/password" : safeReturnPath(input.next);
    const response = NextResponse.json({ redirectTo: next });
    const { error } = await callbackClient(request, response).auth.verifyOtp({ token_hash: input.token_hash, type: input.type });
    if (error) throw new AppError(400, "confirmation_failed", "This link is invalid or expired. Request a new email.");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  });
}

export async function exchangeCode(request: NextRequest) {
  const origin = new URL(config().APP_ORIGIN).origin;
  const next = safeReturnPath(request.nextUrl.searchParams.get("next"));
  const success = NextResponse.redirect(new URL(next, origin), 303);
  const code = request.nextUrl.searchParams.get("code");
  if (code && code.length <= 2048) {
    const { error } = await callbackClient(request, success).auth.exchangeCodeForSession(code);
    if (!error) {
      success.headers.set("cache-control", "private, no-store");
      success.headers.set("referrer-policy", "no-referrer");
      return success;
    }
  }
  return NextResponse.redirect(new URL("/login?error=confirmation_failed", origin), { status: 303, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer" } });
}
