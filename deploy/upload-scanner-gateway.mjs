import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ACTIVE = 4;
const digest = value => createHash("sha256").update(value).digest();
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

/** ClamAV VERSION has no timezone suffix; the daemon must run with TZ=UTC. */
export function signaturePublishedAt(version) {
  const match = /^ClamAV \d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?\/[1-9]\d*\/(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(version);
  if (!match) throw new Error("scanner_version_invalid");
  const [,weekday,month,day,hour,minute,second,year] = match;
  const time = Date.UTC(Number(year),MONTHS.indexOf(month),Number(day),Number(hour),Number(minute),Number(second));
  const date = new Date(time);
  if (Number(year) < 2000 || date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== MONTHS.indexOf(month) ||
      date.getUTCDate() !== Number(day) || date.getUTCHours() !== Number(hour) || date.getUTCMinutes() !== Number(minute) ||
      date.getUTCSeconds() !== Number(second) || WEEKDAYS[date.getUTCDay()] !== weekday) throw new Error("scanner_version_invalid");
  return time;
}

function requireFresh(publishedAt,maxAgeHours,now) {
  const age = now() - publishedAt;
  if (!Number.isFinite(age) || age < -300_000 || age > maxAgeHours * 3_600_000) throw new Error("scanner_signatures_unavailable");
}

function clamd(socketPath,command,bytes) {
  return new Promise((resolvePromise,reject) => {
    const socket = createConnection({ path: socketPath });
    let settled = false,reply = Buffer.alloc(0);
    const finish = (error,value) => {
      if (settled) return;
      settled = true;clearTimeout(deadline);socket.destroy();
      if (error) reject(error); else resolvePromise(value);
    };
    const deadline = setTimeout(() => finish(new Error("scanner_timeout")),command === "scan" ? 20_000 : 1000);
    socket.on("error",() => finish(new Error("scanner_unavailable")));
    socket.on("close",() => { if (!settled) finish(new Error("scanner_incomplete")); });
    socket.on("data",chunk => {
      reply = Buffer.concat([reply,chunk]);
      if (reply.length > (command === "version" ? 256 : 1024)) return finish(new Error("scanner_reply_too_large"));
      const end = reply.indexOf(0);
      if (end < 0) return;
      if (end !== reply.length - 1) return finish(new Error("scanner_reply_invalid"));
      const value = reply.subarray(0,end).toString("utf8");
      if (command === "version") {
        try { finish(null,signaturePublishedAt(value)); }
        catch { finish(new Error("scanner_version_invalid")); }
      }
      else if (command === "scan" && value === "stream: OK") finish(null,"clean");
      else if (command === "scan" && /^stream: [^\r\n\0]+ FOUND$/u.test(value)) finish(null,"infected");
      else finish(new Error("scanner_reply_invalid"));
    });
    socket.on("connect",() => {
      if (command === "version") { socket.write("zVERSION\0");return; }
      const header = Buffer.alloc(4),end = Buffer.alloc(4);
      header.writeUInt32BE(bytes.length);
      socket.write(Buffer.concat([Buffer.from("zINSTREAM\0"),header,bytes,end]));
    });
  });
}

/** Plain HTTP on a private network; a separate trusted edge must terminate HTTPS. */
export function createScannerGateway({ token,socketPath,maxSignatureAgeHours = 72,now = Date.now }) {
  if (typeof token !== "string" || token.length < 32 || token.length > 512 || /\s/u.test(token) ||
      typeof socketPath !== "string" || !isAbsolute(socketPath)) throw new Error("Gateway token and private ClamAV socket are required.");
  if (!Number.isInteger(maxSignatureAgeHours) || maxSignatureAgeHours < 1 || maxSignatureAgeHours > 168 || typeof now !== "function") {
    throw new Error("Set a signature age limit of 1 to 168 whole hours.");
  }
  const freshSignatures = async () => {
    const publishedAt = await clamd(socketPath,"version");
    requireFresh(publishedAt,maxSignatureAgeHours,now);
    return publishedAt;
  };
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
      try { await freshSignatures();send(200,{ status: "ready" }); }
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
      const publishedAt = await freshSignatures();
      const verdict = await clamd(socketPath,"scan",bytes);
      requireFresh(publishedAt,maxSignatureAgeHours,now);
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
  const rawAge = process.env.SCANNER_MAX_SIGNATURE_AGE_HOURS;
  if (rawAge !== undefined && !/^\d{1,3}$/u.test(rawAge)) throw new Error("Set a signature age limit of 1 to 168 whole hours.");
  const server = createScannerGateway({ token: process.env.SCANNER_GATEWAY_TOKEN,
    socketPath: process.env.CLAMD_SOCKET,maxSignatureAgeHours: rawAge === undefined ? 72 : Number(rawAge) });
  const port = Number(process.env.PORT ?? "8081");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Set a valid gateway port.");
  server.listen(port,"0.0.0.0",() => console.log("Upload scanner gateway listening on its private HTTP port."));
}
