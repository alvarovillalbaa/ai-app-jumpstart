import { createHash } from "node:crypto";
import { pingClamd, pingRemoteScanner, remoteScannerSettings } from "@/lib/uploads/scanner";

export const runtime = "nodejs";

const PROBE_INTERVAL_MS = 5_000;
let cached: { key: string; until: number; result: Promise<boolean> } | undefined;

function scannerReady(env: NodeJS.ProcessEnv) {
  const now = Date.now();
  const key = createHash("sha256").update(JSON.stringify([env.UPLOAD_SCANNER_PROVIDER,env.UPLOAD_CLAMD_SOCKET,
    env.UPLOAD_SCANNER_URL,env.UPLOAD_SCANNER_TOKEN,env.VERCEL,env.AWS_LAMBDA_FUNCTION_NAME])).digest("hex");
  if (cached?.key === key && cached.until > now) return cached.result;
  const result = (async () => {
    if (env.UPLOAD_SCANNER_PROVIDER === "remote") return pingRemoteScanner(remoteScannerSettings(env));
    if (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME || env.UPLOAD_SCANNER_PROVIDER !== "clamd" || !env.UPLOAD_CLAMD_SOCKET ||
        env.UPLOAD_SCANNER_URL || env.UPLOAD_SCANNER_TOKEN) return false;
    return pingClamd(env.UPLOAD_CLAMD_SOCKET);
  })().catch(() => false);
  cached = { key,until: now + PROBE_INTERVAL_MS,result };
  return result;
}

/** Monitor the optional scanner separately so record traffic stays available. */
export async function GET() {
  const env = process.env;
  const configured = Boolean(env.UPLOAD_SCANNER_PROVIDER || env.UPLOAD_CLAMD_SOCKET || env.UPLOAD_SCANNER_URL ||
    env.UPLOAD_SCANNER_TOKEN || env.UPLOAD_DOWNLOAD_POLICY === "scan-on-read");
  const ready = configured && await scannerReady(env);
  const status = !configured ? "disabled" : ready ? "ready" : "unavailable";
  return Response.json({ status,checks: { scanner: !configured ? "disabled" : ready ? "ok" : "failed" } },{
    status: configured && !ready ? 503 : 200,
    headers: { "cache-control": "no-store","x-content-type-options": "nosniff" },
  });
}
