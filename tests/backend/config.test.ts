import { expect, it } from "vitest";
import { config } from "../../lib/config";
import { trustedHttpOrigin } from "../../lib/security/origin";

it("uses a local development default but requires an explicit public origin in production", () => {
  expect(config({ NODE_ENV: "development" }).APP_ORIGIN).toBe("http://localhost:3000");
  expect(() => config({ NODE_ENV: "production" })).toThrow(expect.objectContaining({ status: 503, code: "configuration_error" }));
  expect(config({ NODE_ENV: "production", APP_ORIGIN: "https://APP.example:443/" }).APP_ORIGIN).toBe("https://app.example");
  expect(config({ NODE_ENV: "production", APP_ORIGIN: "http://127.0.0.1:3137" }).APP_ORIGIN).toBe("http://127.0.0.1:3137");
});

it("rejects credential-bearing or misrouted origins before a backend secret can be used", () => {
  for (const origin of ["http://public.example", "ftp://public.example", "https://user:secret@public.example", "https://public.example/path", "https://public.example/?token=secret", "https://public.example/#fragment", "https://public.example/?"]) {
    expect(trustedHttpOrigin(origin)).toBeNull();
    expect(() => config({ NODE_ENV: "production", APP_ORIGIN: origin })).toThrow(expect.objectContaining({ status: 503, code: "configuration_error" }));
  }
  const provider = { NODE_ENV: "production" as const, APP_ORIGIN: "https://app.example", DATA_PROVIDER: "supabase", SUPABASE_SECRET_KEY: "private-fixture" };
  expect(() => config({ ...provider, SUPABASE_URL: "http://remote.example" })).toThrow(expect.objectContaining({ status: 503, code: "configuration_error" }));
  expect(() => config({ ...provider, SUPABASE_URL: "https://service.example/path" })).toThrow(expect.objectContaining({ status: 503, code: "configuration_error" }));
  expect(config({ ...provider, SUPABASE_URL: "https://service.example:443/" }).SUPABASE_URL).toBe("https://service.example");
  expect(config({ ...provider, SUPABASE_URL: "http://127.0.0.1:54321" }).SUPABASE_URL).toBe("http://127.0.0.1:54321");
});

it("rejects an unsafe Convex origin during configuration rather than after a request", () => {
  const base = { NODE_ENV: "production" as const, APP_ORIGIN: "https://app.example", DATA_PROVIDER: "convex", CONVEX_BACKEND_SECRET: "fixture-secret-".repeat(3) };
  expect(() => config({ ...base, CONVEX_SITE_URL: "http://remote.convex.site" })).toThrow(expect.objectContaining({ status: 503, code: "configuration_error" }));
  expect(config({ ...base, CONVEX_SITE_URL: "https://test.convex.site" }).CONVEX_SITE_URL).toBe("https://test.convex.site");
});
