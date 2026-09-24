import { createConnection } from "node:net";
import { isAbsolute } from "node:path";
import { AppError } from "../http/errors";
import { MAX_UPLOAD_BYTES } from "./validation";

export type UploadScanVerdict = "clean" | "infected";
export interface UploadScanner { scan(bytes: Uint8Array): Promise<UploadScanVerdict> }

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
  if (!env.UPLOAD_SCANNER_PROVIDER && !env.UPLOAD_CLAMD_SOCKET) return null;
  if (env.UPLOAD_SCANNER_PROVIDER !== "clamd" || !env.UPLOAD_CLAMD_SOCKET || !isAbsolute(env.UPLOAD_CLAMD_SOCKET)) {
    throw new AppError(503, "scanner_unavailable", "Configure a private ClamAV Unix socket for upload scanning.");
  }
  return { scan: bytes => scanWithClamd(env.UPLOAD_CLAMD_SOCKET!, bytes) };
}
