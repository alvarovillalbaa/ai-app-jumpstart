import { pingClamd } from "@/lib/uploads/scanner";

export const runtime = "nodejs";

/** Monitor the optional scanner separately so record traffic stays available. */
export async function GET() {
  const env = process.env;
  const configured = Boolean(env.UPLOAD_SCANNER_PROVIDER || env.UPLOAD_CLAMD_SOCKET || env.UPLOAD_DOWNLOAD_POLICY === "scan-on-read");
  const ready = configured && !env.VERCEL && !env.AWS_LAMBDA_FUNCTION_NAME &&
    env.UPLOAD_SCANNER_PROVIDER === "clamd" && Boolean(env.UPLOAD_CLAMD_SOCKET) &&
    await pingClamd(env.UPLOAD_CLAMD_SOCKET!).catch(() => false);
  const status = !configured ? "disabled" : ready ? "ready" : "unavailable";
  return Response.json({ status,checks: { scanner: !configured ? "disabled" : ready ? "ok" : "failed" } },{
    status: configured && !ready ? 503 : 200,
    headers: { "cache-control": "no-store","x-content-type-options": "nosniff" },
  });
}
