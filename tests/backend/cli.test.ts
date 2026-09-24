import { afterEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../scripts/app-cli";
import { recordHandlers } from "../../lib/http/records";
import { SqliteRepository } from "../../lib/data/sqlite";

afterEach(() => vi.unstubAllEnvs());
it("runs CLI CRUD through the HTTP handlers and propagates failures", async () => {
  const token = "cli-test-secret-".repeat(3);
  vi.stubEnv("APP_API_KEYS", JSON.stringify([{ sha256: createHash("sha256").update(token).digest("hex"), tenant: "test", subject: "cli", scopes: ["records:read", "records:write"] }]));
  const repo = new SqliteRepository(":memory:"), api = recordHandlers(async () => repo);
  const request: typeof fetch = async (url, init) => {
    const req = new Request(url, init), id = new URL(req.url).pathname.split("/")[4];
    if (req.method === "POST") return api.create(req);
    if (req.method === "PATCH") return api.update(req, id);
    if (req.method === "DELETE") return api.delete(req, id);
    return id ? api.get(req, id) : api.list(req);
  };
  const env = { APP_API_TOKEN: token }, dir = await mkdtemp(join(tmpdir(), "jumpstart-cli-"));
  try {
    const file = join(dir, "record.json");
    await writeFile(file, JSON.stringify({ title: "CLI", content: "Example" }));
    const row = await run(["create", file], env, request) as { id: string };
    expect(await run(["get", row.id], env, request)).toMatchObject({ title: "CLI", revision: 1 });
    await writeFile(file, JSON.stringify({ title: "Changed", content: "Example", revision: 1 }));
    expect(await run(["update", row.id, file], env, request)).toMatchObject({ revision: 2 });
    await expect(run(["delete", row.id, "1"], env, request)).rejects.toThrow("HTTP 409");
    expect(await run(["delete", row.id, "2"], env, request)).toEqual({ deleted: true });
    await expect(run(["get", row.id], env, request)).rejects.toThrow("HTTP 404");
    await expect(run(["list"], { ...env, APP_API_URL: "http://remote.example" }, request)).rejects.toThrow("HTTPS");
  } finally { await repo.close(); await rm(dir, { recursive: true }); }
});

it("passes an optional Vercel protection bypass only as a request header", async () => {
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(new URL(String(url)).searchParams.has("x-vercel-protection-bypass")).toBe(false);
    expect(new Headers(init?.headers).get("x-vercel-protection-bypass")).toBe("private-bypass");
    return Response.json({ items: [], nextCursor: null });
  });
  await run(["list"], {
    APP_API_URL: "https://protected.example", APP_API_TOKEN: "record-token",
    VERCEL_AUTOMATION_BYPASS_SECRET: "private-bypass",
  }, request);
  expect(request).toHaveBeenCalledOnce();
});

it("routes artifact deletion through the authenticated API without a body",async () => {
  const id = crypto.randomUUID(),request = vi.fn<typeof fetch>(async (url,init) => {
    expect(new URL(String(url)).pathname).toBe(`/api/v1/artifacts/${id}`);
    expect(init?.method).toBe("DELETE");
    expect(init?.body).toBeUndefined();
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer owner-token");
    return new Response(null,{ status: 204 });
  });
  expect(await run(["artifacts","delete",id],{ APP_API_TOKEN: "owner-token" },request)).toEqual({ deleted: true });
  expect(request).toHaveBeenCalledOnce();
});
