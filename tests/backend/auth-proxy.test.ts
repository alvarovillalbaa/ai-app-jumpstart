import { afterEach, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CookieMethodsServer } from "@supabase/ssr";
const state = vi.hoisted(() => ({ run: async (cookies: CookieMethodsServer) => { void cookies; } }));
vi.mock("@supabase/ssr", () => ({ createServerClient: (_url: string, _key: string, options: { cookies: CookieMethodsServer }) => ({ auth: { getUser: async () => { await state.run(options.cookies); return { data: { user: null }, error: null }; } } }) }));
import { refreshSession } from "../../lib/auth/proxy";
afterEach(() => vi.unstubAllEnvs());
it("forwards refreshed request cookies and all response cookie chunks and cache headers", async () => {
  vi.stubEnv("AUTH_PROVIDER", "supabase"); vi.stubEnv("SUPABASE_AUTH_URL", "https://identity.example"); vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_fixture");
  state.run = async cookies => {
    expect(await cookies.getAll?.()).toEqual([{ name: "sb-session.0", value: "old" }]);
    await cookies.setAll?.([{ name: "sb-session.0", value: "fresh", options: { path: "/", sameSite: "lax" } }], { "cache-control": "private, no-store", expires: "0", pragma: "no-cache" });
    await cookies.setAll?.([{ name: "sb-session.1", value: "second", options: { path: "/", sameSite: "lax" } }], {});
  };
  const forwarded = new Headers({ cookie: "sb-session.0=old", "x-nonce": "fixture-nonce", "Content-Security-Policy": "script-src 'nonce-fixture-nonce'" });
  const response = await refreshSession(new NextRequest("http://localhost:3000/account", { headers: { cookie: "sb-session.0=old" } }), forwarded);
  expect(response.cookies.get("sb-session.0")?.value).toBe("fresh"); expect(response.cookies.get("sb-session.1")?.value).toBe("second");
  expect(response.headers.get("x-middleware-request-cookie")).toContain("sb-session.0=fresh");
  expect(response.headers.get("x-middleware-request-cookie")).toContain("sb-session.1=second");
  expect(response.headers.get("x-middleware-request-x-nonce")).toBe("fixture-nonce");
  expect(response.headers.get("x-middleware-request-content-security-policy")).toContain("nonce-fixture-nonce");
  expect(response.headers.get("cache-control")).toContain("no-store"); expect(response.headers.get("expires")).toBe("0"); expect(response.headers.get("pragma")).toBe("no-cache");
});
