import { pingClamd } from "@/lib/uploads/scanner";

export const runtime = "nodejs";

const PROBE_INTERVAL_MS = 5_000;
let cached: { socketPath: string; until: number; result: Promise<boolean> } | undefined;

function scannerReady(socketPath: string) {
  const now = Date.now();
  if (cached?.socketPath === socketPath && cached.until > now) return cached.result;
  const result = pingClamd(socketPath).catch(() => false);
  cached = { socketPath,until: now + PROBE_INTERVAL_MS,result };
  return result;
}

/** Monitor the optional scanner separately so record traffic stays available. */
export async function GET() {
  const env = process.env;
  const configured = Boolean(env.UPLOAD_SCANNER_PROVIDER || env.UPLOAD_CLAMD_SOCKET || env.UPLOAD_DOWNLOAD_POLICY === "scan-on-read");
  const ready = configured && !env.VERCEL && !env.AWS_LAMBDA_FUNCTION_NAME &&
    env.UPLOAD_SCANNER_PROVIDER === "clamd" && Boolean(env.UPLOAD_CLAMD_SOCKET) &&
    await scannerReady(env.UPLOAD_CLAMD_SOCKET!);
  const status = !configured ? "disabled" : ready ? "ready" : "unavailable";
  return Response.json({ status,checks: { scanner: !configured ? "disabled" : ready ? "ok" : "failed" } },{
    status: configured && !ready ? 503 : 200,
    headers: { "cache-control": "no-store","x-content-type-options": "nosniff" },
  });
}
