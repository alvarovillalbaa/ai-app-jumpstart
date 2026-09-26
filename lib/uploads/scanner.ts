import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { AppError } from "../http/errors";
import { MAX_UPLOAD_BYTES } from "./validation";

export type UploadScanVerdict = "clean" | "infected";
export interface UploadScanner { scan(bytes: Uint8Array): Promise<UploadScanVerdict> }

const remoteVerdict = z.object({ verdict: z.enum(["clean","infected"]),sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const remoteHealth = z.object({ status: z.literal("ready") }).strict();
type RemoteSettings = { url: string; token: string };

/** The endpoint is operator-owned; callers cannot choose where upload bytes go. */
export function remoteScannerSettings(env: Record<string, string | undefined>): RemoteSettings {
  const raw = env.UPLOAD_SCANNER_URL,token = env.UPLOAD_SCANNER_TOKEN;
  let url: URL;
  try { url = new URL(raw ?? ""); }
  catch { throw new AppError(503,"scanner_unavailable","Configure an authenticated HTTPS upload scanner."); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/u,"");
  if (env.UPLOAD_SCANNER_PROVIDER !== "remote" || env.UPLOAD_CLAMD_SOCKET || !raw || raw.length > 500 ||
      url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      ["localhost","[::1]"].includes(hostname) || hostname.endsWith(".localhost") || hostname.startsWith("127.") ||
      !token || token.length < 32 || token.length > 512 || /\s/u.test(token)) {
    throw new AppError(503,"scanner_unavailable","Configure an authenticated HTTPS upload scanner.");
  }
  return { url: url.toString(),token };
}

async function smallJson(response: Response) {
  if (response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Scanner response was unavailable.");
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 256)) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Scanner response was too large.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Scanner response was empty.");
  const chunks: Uint8Array[] = [];let length = 0;
  try {
    while (true) {
      const { value,done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256) throw new Error("Scanner response was too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {});reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks,length).toString("utf8")); }
  catch { throw new Error("Scanner response was invalid."); }
}

/** Authenticated HTTPS protocol for a separately deployed malware scanner. */
export async function scanWithRemote(settings: RemoteSettings,bytes: Uint8Array): Promise<UploadScanVerdict> {
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES) throw new Error("Invalid upload size for scanning.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const response = await fetch(settings.url,{ method: "POST",redirect: "error",cache: "no-store",
    signal: AbortSignal.timeout(20_000),body: Buffer.from(bytes),
    headers: { authorization: `Bearer ${settings.token}`,"content-type": "application/octet-stream",
      "x-content-sha256": sha256 } });
  const result = remoteVerdict.parse(await smallJson(response));
  if (result.sha256 !== sha256) throw new Error("Scanner verdict did not match the upload bytes.");
  return result.verdict;
}

/** Liveness only; the operator preflight checks clean and infected controls. */
export async function pingRemoteScanner(settings: RemoteSettings): Promise<boolean> {
  try {
    const response = await fetch(settings.url,{ method: "GET",redirect: "error",cache: "no-store",
      signal: AbortSignal.timeout(1500),headers: { authorization: `Bearer ${settings.token}` } });
    return remoteHealth.safeParse(await smallJson(response)).success;
  } catch { return false; }
}

/** A bounded daemon liveness probe; it does not validate signatures or scan policy. */
export function pingClamd(socketPath: string): Promise<boolean> {
  if (!isAbsolute(socketPath)) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket = createConnection({ path: socketPath });
    let settled = false,reply = Buffer.alloc(0);
    function finish(ready: boolean) {
      if (settled) return;
      settled = true;socket.destroy();resolve(ready);
    }
    socket.setTimeout(1500,() => finish(false));
    socket.on("error",() => finish(false));
    socket.on("close",() => finish(false));
    socket.on("data",chunk => {
      if (reply.length + chunk.length > 5) return finish(false);
      reply = Buffer.concat([reply,chunk]);
      if (reply.includes(0)) finish(reply.equals(Buffer.from("PONG\0")));
    });
    socket.on("connect",() => socket.write("zPING\0"));
  });
}

/** ClamAV's INSTREAM protocol keeps paths and backend credentials off the scanner. */
export function scanWithClamd(socketPath: string, bytes: Uint8Array): Promise<UploadScanVerdict> {
  if (!isAbsolute(socketPath) || !bytes.length || bytes.length > MAX_UPLOAD_BYTES) {
    return Promise.reject(new Error("Invalid scanner socket or upload size."));
  }
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false;
    let reply = Buffer.alloc(0);
    function finish(error?: Error, verdict?: UploadScanVerdict) {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(verdict!);
    }
    socket.setTimeout(20_000, () => finish(new Error("Scanner timed out.")));
    socket.on("error", () => finish(new Error("Scanner connection failed.")));
    socket.on("close", () => { if (!settled) finish(new Error("Scanner reply was incomplete.")); });
    socket.on("data", chunk => {
      reply = Buffer.concat([reply, chunk]);
      if (reply.length > 1024) return finish(new Error("Scanner reply was too large."));
      const end = reply.indexOf(0);
      if (end < 0) return;
      if (end !== reply.length - 1) return finish(new Error("Scanner reply had trailing data."));
      const result = reply.subarray(0, end).toString("utf8");
      if (result === "stream: OK") finish(undefined, "clean");
      else if (/^stream: [^\r\n\0]+ FOUND$/u.test(result)) finish(undefined, "infected");
      else finish(new Error("Scanner did not return a valid verdict."));
    });
    socket.on("connect", () => {
      const header = Buffer.alloc(4), end = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      socket.write(Buffer.concat([Buffer.from("zINSTREAM\0"), header, Buffer.from(bytes), end]));
    });
  });
}

/** Scanner configuration is explicit; unknown or partial settings fail closed for writes. */
export async function createUploadScanner(env: Record<string, string | undefined> = process.env): Promise<UploadScanner | null> {
  if (!env.UPLOAD_SCANNER_PROVIDER && !env.UPLOAD_CLAMD_SOCKET && !env.UPLOAD_SCANNER_URL && !env.UPLOAD_SCANNER_TOKEN) return null;
  if (env.UPLOAD_SCANNER_PROVIDER === "remote") {
    const settings = remoteScannerSettings(env);
    return { scan: bytes => scanWithRemote(settings,bytes) };
  }
  if (env.UPLOAD_SCANNER_PROVIDER !== "clamd" || !env.UPLOAD_CLAMD_SOCKET || !isAbsolute(env.UPLOAD_CLAMD_SOCKET) ||
      env.UPLOAD_SCANNER_URL || env.UPLOAD_SCANNER_TOKEN) {
    throw new AppError(503, "scanner_unavailable", "Configure a private ClamAV Unix socket for upload scanning.");
  }
  return { scan: bytes => scanWithClamd(env.UPLOAD_CLAMD_SOCKET!, bytes) };
}
