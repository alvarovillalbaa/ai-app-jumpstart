import { afterEach, expect, it, vi } from "vitest";
import { runHostedSmoke } from "../../scripts/smoke-hosted.mjs";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("refuses remote smoke writes without a staging acknowledgment before making a request", async () => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);

  await expect(runHostedSmoke({ url: "https://app.example",token: "primary-token",otherToken: "other-token" }))
    .rejects.toThrow("APP_SMOKE_TARGET=staging");
  expect(request).not.toHaveBeenCalled();
});

it("recovers and deletes a keyed record after the create response is lost without retrying the write", async () => {
  const record = { id: "33b005d8-3320-4eac-b2d8-2d55c22ddb4b",revision: 1 };
  let creationKey = "", deleted = false, createCalls = 0, deletionCalls = 0;
  vi.spyOn(console,"log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (input: URL, init?: RequestInit) => {
    const url = new URL(String(input)), method = init?.method ?? "GET",headers = new Headers(init?.headers);
    if (url.pathname === "/api/health/live") return Response.json({ status: "ready" });
    if (url.pathname === "/api/health/ready") return Response.json({ status: "ready",checks: { data: "ok" } });
    if (url.pathname === "/eve/v1/health") return Response.json({ status: "ready" });
    if (url.pathname === "/records") return new Response("<html></html>",{ headers: { "content-type": "text/html" } });
    if (url.pathname === "/api/v1/records" && method === "GET") return new Response(null,{ status: 401 });
    if (url.pathname === "/api/v1/records" && method === "POST") {
      createCalls++;
      expect(headers.get("authorization")).toBe("Bearer primary-token");
      expect(headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
      creationKey ||= headers.get("idempotency-key")!;
      expect(headers.get("idempotency-key")).toBe(creationKey);
      if (createCalls === 1) throw new Error("simulated lost create response");
      expect(deleted).toBe(true);
      return new Response(null,{ status: 410 });
    }
    if (url.pathname === `/api/v1/records/creation/${creationKey}` && method === "GET") {
      expect(headers.get("authorization")).toBe("Bearer primary-token");
      return Response.json(deleted ? { status: "deleted",id: record.id } : { status: "created",record });
    }
    if (url.pathname === `/api/v1/records/${record.id}` && method === "DELETE") {
      expect(headers.get("authorization")).toBe("Bearer primary-token");
      expect(url.searchParams.get("revision")).toBe("1");
      deletionCalls++; deleted = true;
      return new Response(null,{ status: 204 });
    }
    throw new Error(`Unexpected hosted smoke request: ${method} ${url.pathname}`);
  }));

  await expect(runHostedSmoke({ url: "https://app.example",token: "primary-token",otherToken: "other-token",target: "staging" }))
    .rejects.toThrow("simulated lost create response");
  expect(deleted).toBe(true);
  expect(deletionCalls).toBe(1);
  expect(createCalls).toBe(2); // Initial write and post-deletion fence check only.
});
