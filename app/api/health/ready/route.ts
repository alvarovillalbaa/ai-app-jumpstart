import { getRepository } from "@/lib/data/repository";
export const runtime = "nodejs";

async function localAgentReady() {
  const port = process.env.EVE_NEXT_PRODUCTION_PORT ?? "4274";
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) return false;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/eve/v1/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500),
    });
    return response.ok && (await response.json()).status === "ready";
  } catch { return false; }
}

export async function GET() {
  const checkAgent = process.env.APP_AGENT_READINESS === "local";
  const [dataReady, agentReady] = await Promise.all([
    Promise.resolve().then(async () => { await (await getRepository()).health(); return true; }).catch(() => false),
    checkAgent ? localAgentReady() : Promise.resolve(null),
  ]);
  const ready = dataReady && agentReady !== false;
  return Response.json({
    status: ready ? "ready" : "unavailable",
    checks: { data: dataReady ? "ok" : "failed", ...(checkAgent ? { agent: agentReady ? "ok" : "failed" } : {}) },
  }, { status: ready ? 200 : 503, headers: { "cache-control": "no-store" } });
}
