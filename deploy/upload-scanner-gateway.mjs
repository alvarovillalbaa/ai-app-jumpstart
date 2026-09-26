import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ACTIVE = 4;
const digest = value => createHash("sha256").update(value).digest();

function clamd(socketPath,command,bytes) {
  return new Promise((resolvePromise,reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false,reply = Buffer.alloc(0);
    const finish = (error,value) => {
      if (settled) return;
      settled = true;socket.destroy();
      if (error) reject(error); else resolvePromise(value);
    };
    socket.setTimeout(20_000,() => finish(new Error("scanner_timeout")));
    socket.on("error",() => finish(new Error("scanner_unavailable")));
    socket.on("close",() => { if (!settled) finish(new Error("scanner_incomplete")); });
    socket.on("data",chunk => {
      reply = Buffer.concat([reply,chunk]);
      if (reply.length > (command === "ping" ? 5 : 1024)) return finish(new Error("scanner_reply_too_large"));
      const end = reply.indexOf(0);
      if (end < 0) return;
      if (end !== reply.length - 1) return finish(new Error("scanner_reply_invalid"));
      const value = reply.subarray(0,end).toString("utf8");
      if (command === "ping" && value === "PONG") finish(null,"ready");
      else if (command === "scan" && value === "stream: OK") finish(null,"clean");
      else if (command === "scan" && /^stream: [^\r\n\0]+ FOUND$/u.test(value)) finish(null,"infected");
      else finish(new Error("scanner_reply_invalid"));
    });
    socket.on("connect",() => {
      if (command === "ping") { socket.write("zPING\0");return; }
      const header = Buffer.alloc(4),end = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      socket.write(Buffer.concat([Buffer.from("zINSTREAM\0"),header,bytes,end]));
    });
  });
}

/** Plain HTTP on a private network; a separate trusted edge must terminate HTTPS. */
export function createScannerGateway({ token,socketPath }) {
  if (typeof token !== "string" || token.length < 32 || token.length > 512 || /\s/u.test(token) ||
      typeof socketPath !== "string" || !isAbsolute(socketPath)) throw new Error("Gateway token and private ClamAV socket are required.");
  const expected = digest(token);
  let active = 0;
  const server = createServer(async (req,res) => {
    const send = (status,value) => {
      if (res.headersSent) return;
      res.writeHead(status,{ "content-type": "application/json","cache-control": "no-store",
        "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(value));
    };
    if (req.url !== "/v1/scan") return send(404,{ error: "not_found" });
    const auth = req.headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ") || auth.length > 600 ||
        !timingSafeEqual(digest(auth.slice(7)),expected)) return send(401,{ error: "unauthorized" });
    if (req.method === "GET") {
      try { await clamd(socketPath,"ping");send(200,{ status: "ready" }); }
      catch { send(503,{ error: "scanner_unavailable" }); }
      return;
    }
    if (req.method !== "POST") return send(405,{ error: "method_not_allowed" });
    if (active >= MAX_ACTIVE) return send(429,{ error: "scanner_busy" });
    if (req.headers["content-type"] !== "application/octet-stream" ||
        (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")) {
      return send(415,{ error: "unsupported_media_type" });
    }
    const declared = req.headers["x-content-sha256"];
    if (typeof declared !== "string" || !/^[a-f0-9]{64}$/.test(declared)) return send(400,{ error: "invalid_digest" });
    const contentLength = req.headers["content-length"];
    if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_BYTES)) return send(413,{ error: "body_too_large" });
    active++;
    try {
      const chunks = [];let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) return send(413,{ error: "body_too_large" });
        chunks.push(chunk);
      }
      if (!size || (contentLength && Number(contentLength) !== size)) return send(400,{ error: "invalid_body" });
      const bytes = Buffer.concat(chunks,size),actual = digest(bytes);
      if (!timingSafeEqual(Buffer.from(declared,"hex"),actual)) return send(400,{ error: "digest_mismatch" });
      const verdict = await clamd(socketPath,"scan",bytes);
      send(200,{ verdict,sha256: actual.toString("hex") });
    } catch { send(503,{ error: "scanner_unavailable" }); }
    finally { active--; }
  });
  server.requestTimeout = 25_000;
  server.headersTimeout = 10_000;
  server.maxHeadersCount = 32;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createScannerGateway({ token: process.env.SCANNER_GATEWAY_TOKEN,
    socketPath: process.env.CLAMD_SOCKET });
  const port = Number(process.env.PORT ?? "8081");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Set a valid gateway port.");
  server.listen(port,"0.0.0.0",() => console.log("Upload scanner gateway listening on its private HTTP port."));
}
