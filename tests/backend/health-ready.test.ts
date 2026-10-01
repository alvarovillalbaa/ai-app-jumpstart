import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { health,limitHealth } = vi.hoisted(() => ({ health: vi.fn(),limitHealth: vi.fn() }));
vi.mock("@/lib/data/repository", () => ({ getRepository: async () => ({ health }) }));
vi.mock("@/lib/request-limits/store",() => ({ getRequestLimitStore: async () => ({ health: limitHealth }) }));

import { GET } from "@/app/api/health/ready/route";

describe("readiness", () => {
  beforeEach(() => { health.mockReset().mockResolvedValue(undefined);limitHealth.mockReset().mockResolvedValue(undefined);vi.stubEnv("APP_REQUESTS_PER_MINUTE","0"); });
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("reports application data readiness when Eve is hosted separately", async () => {
    vi.stubEnv("APP_AGENT_READINESS", "external");
    const fetchAgent = vi.fn();
    vi.stubGlobal("fetch", fetchAgent);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ready", checks: { data: "ok" } });
    expect(fetchAgent).not.toHaveBeenCalled();
    expect(limitHealth).not.toHaveBeenCalled();
  });

  it("requires read-only request limiter readiness only when configured",async () => {
    vi.stubEnv("APP_AGENT_READINESS","external");vi.stubEnv("APP_REQUESTS_PER_MINUTE","120");
    expect((await GET()).status).toBe(200);expect(limitHealth).toHaveBeenCalledOnce();
    limitHealth.mockRejectedValue(new Error("private database connection"));
    const response = await GET();expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable",checks: { data: "failed" } });
    vi.stubEnv("APP_REQUESTS_PER_MINUTE","invalid");limitHealth.mockClear();
    expect((await GET()).status).toBe(503);expect(limitHealth).not.toHaveBeenCalled();
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
