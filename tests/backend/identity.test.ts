import { afterEach, expect, it, vi } from "vitest";
import { authenticate } from "../../lib/http/auth";
import { authSettings, safeReturnPath } from "../../lib/auth/settings";
import { recordHandlers } from "../../lib/http/records";
import { SqliteRepository } from "../../lib/data/sqlite";

const settings: NodeJS.ProcessEnv = { NODE_ENV: "test", AUTH_PROVIDER: "supabase", SUPABASE_AUTH_URL: "https://identity.example", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_fixture", APP_API_KEYS: "[]" };
const token = "verified-access-token-".repeat(3);
const user = { id: "0c9074e3-a19e-44ba-8931-8d1c84661297", aud: "authenticated", role: "authenticated", email: "test@example.test", is_anonymous: false, created_at: new Date().toISOString(), app_metadata: {}, user_metadata: { tenant: "admin", subject: "somebody-else", scopes: ["all"] } };
const request = () => new Request("http://localhost:3000/api/v1/records", { headers: { authorization: `Bearer ${token}` } });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("uses the verified identity, excludes editable metadata, and does not cache identity responses", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(user)); vi.stubGlobal("fetch", fetcher);
  expect(await authenticate(request(), settings)).toEqual({ tenant: "supabase:https://identity.example", subject: user.id, scopes: ["records:read", "records:write", "uploads:read", "uploads:write"], credentialType: "user" });
  const [url, options] = fetcher.mock.calls[0];
  expect(String(url)).toBe("https://identity.example/auth/v1/user");
  expect(new Headers(options.headers).get("authorization")).toBe(`Bearer ${token}`);
  expect(options.cache).toBe("no-store"); expect(options.redirect).toBe("error");
});

it("rejects expired/revoked credentials and anonymous users; separates provider downtime", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ msg: "Session revoked", code: "session_not_found" }, { status: 401 })));
  await expect(authenticate(request(), settings)).rejects.toMatchObject({ status: 401 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...user, is_anonymous: true })));
  await expect(authenticate(request(), settings)).rejects.toMatchObject({ status: 401 });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ msg: "Internal failure" }, { status: 500 })));
  await expect(authenticate(request(), settings)).rejects.toMatchObject({ status: 503 });
});

it("shares owner isolation across the actual HTTP service with Supabase identities", async () => {
  Object.entries(settings).forEach(([key, value]) => vi.stubEnv(key, value));
  const repo = new SqliteRepository(":memory:");
  const api = recordHandlers(async () => repo);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(user)));
  try {
    const created = await api.create(new Request(request(), { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ title: "Private", content: "Owner one" }) }));
    expect(created.status).toBe(201); const record = await created.json();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ ...user, id: "f0459d88-a0eb-4132-b2d6-e8b279a733a1" })));
    expect((await api.get(request(), record.id)).status).toBe(404);
  } finally { await repo.close(); }
});

it("does not expose secret keys or allow hostile auth origins and return paths", () => {
  expect(() => authSettings({ ...settings, SUPABASE_PUBLISHABLE_KEY: "sb_secret_do_not_serialize" })).toThrow();
  const legacySecret = `header.${Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url")}.signature`;
  expect(() => authSettings({ ...settings, SUPABASE_PUBLISHABLE_KEY: legacySecret })).toThrow();
  for (const url of ["http://identity.example", "https://user:secret@identity.example", "https://identity.example/other", "https://identity.example?redirect=evil"]) expect(() => authSettings({ ...settings, SUPABASE_AUTH_URL: url })).toThrow();
  for (const path of ["//evil.example", "https://evil.example", "/account?next=https://evil.example", "/\\evil.example", "/account/../evil"]) expect(safeReturnPath(path)).toBe("/account");
  expect(safeReturnPath("/account/password")).toBe("/account/password");
});
