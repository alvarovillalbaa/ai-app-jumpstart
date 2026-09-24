import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { health } = vi.hoisted(() => ({ health: vi.fn() }));
vi.mock("@/lib/data/repository", () => ({ getRepository: async () => ({ health }) }));

import { GET } from "@/app/api/health/ready/route";

describe("readiness", () => {
  beforeEach(() => { health.mockReset().mockResolvedValue(undefined); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("reports application data readiness when Eve is hosted separately", async () => {
    vi.stubEnv("APP_AGENT_READINESS", "external");
    const fetchAgent = vi.fn();
    vi.stubGlobal("fetch", fetchAgent);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", checks: { data: "ok" } });
    expect(fetchAgent).not.toHaveBeenCalled();
  });

  it("requires the co-located agent to report ready", async () => {
    vi.stubEnv("APP_AGENT_READINESS", "local");
    vi.stubEnv("EVE_NEXT_PRODUCTION_PORT", "4274");
    const fetchAgent = vi.fn().mockResolvedValue(Response.json({ status: "ready" }));
    vi.stubGlobal("fetch", fetchAgent);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", checks: { data: "ok", agent: "ok" } });
    expect(fetchAgent).toHaveBeenCalledWith("http://127.0.0.1:4274/eve/v1/health", expect.objectContaining({ cache: "no-store" }));
  });

  it("removes an instance from service when its local agent is unavailable", async () => {
    vi.stubEnv("APP_AGENT_READINESS", "local");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "unavailable", checks: { data: "ok", agent: "failed" } });
  });

  it("reports both dependency failures without revealing errors", async () => {
    vi.stubEnv("APP_AGENT_READINESS", "local");
    health.mockRejectedValue(new Error("secret database URL"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ status: "starting" }, { status: 503 })));
    const response = await GET();
    expect(response.status).toBe(503);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({ status: "unavailable", checks: { data: "failed", agent: "failed" } });
    expect(body).not.toContain("secret database URL");
  });
});
