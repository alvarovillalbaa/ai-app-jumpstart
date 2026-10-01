import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { refreshSession } from "./lib/auth/proxy";
import { trustedHttpOrigin } from "./lib/security/origin";

function contentSecurityPolicy(nonce: string) {
  const auth = trustedHttpOrigin(process.env.SUPABASE_AUTH_URL ?? process.env.SUPABASE_URL);
  const connect = ["'self'", ...(auth ? [auth] : []), ...(process.env.NODE_ENV === "development" ? ["ws:"] : [])];
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    `style-src-elem 'self' 'nonce-${nonce}'`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src ${connect.join(" ")}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export async function proxy(request: NextRequest) {
  const nonce = randomBytes(16).toString("base64");
  const csp = contentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const path = request.nextUrl.pathname;
  const refresh = path === "/account" || path.startsWith("/account/") || path === "/auth" || path.startsWith("/auth/") ||
    ["/login", "/signup", "/recover"].includes(path);
  const response = refresh ? await refreshSession(request, requestHeaders) : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = { matcher: ["/((?!api(?:/|$)|eve(?:/|$)|_next/|\\.well-known/|.*\\.[a-zA-Z0-9]+$).*)"] };
