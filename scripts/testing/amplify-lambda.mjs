import { createServer, request as proxyRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Writable } from "node:stream";

// Local API Gateway v1 / Lambda streaming transport, not an AWS emulator.
// HTTP response bytes come from the actual adapter bundle. The local ingress
// forwards Eve prefixes directly to the separately compiled worker.
globalThis.awslambda = { streamifyResponse: callback => callback };
const root = resolve(process.env.TEST_APP_ROOT);
const manifest = JSON.parse(await readFile(resolve(root, ".amplify-build/manifest.json"), "utf8"));
const { handler } = await import(pathToFileURL(resolve(manifest.compute.default.bundle, "index.mjs")));
const staticRoot = resolve(manifest.staticAssets.directory);
const staticPaths = new Set(manifest.routes.filter(row => row.target === "s3" && !row.pattern.includes("*")).map(row => row.pattern));
const types = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const delimiter = Buffer.alloc(8);
let invocations = 0;
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, process.env.APP_ORIGIN);
    if (url.pathname.startsWith("/eve/") || url.pathname.startsWith("/.well-known/workflow/")) {
      const target = new URL(process.env.TEST_EVE_ORIGIN);
      const upstream = proxyRequest({ hostname: target.hostname, port: target.port, path: request.url,
        method: request.method, headers: request.headers }, result => {
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      upstream.on("error", () => { response.writeHead(502); response.end(); });
      request.pipe(upstream); return;
    }
    if (url.pathname.startsWith("/_next/static/") || staticPaths.has(url.pathname)) {
      const path = resolve(staticRoot, "." + decodeURIComponent(url.pathname));
      if (!path.startsWith(staticRoot + sep)) throw new Error("Invalid asset path");
      try {
        const bytes = await readFile(path);
        response.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" }); response.end(bytes);
      } catch { response.writeHead(404); response.end(); }
      return;
    }
    const chunks = []; let size = 0;
    for await (const chunk of request) {
      size += chunk.length; if (size > 1024 * 1024) throw new Error("Fixture input too large"); chunks.push(chunk);
    }
    const parameters = {};
    for (const [key, value] of url.searchParams) (parameters[key] ??= []).push(value);
    const event = { path: url.pathname, httpMethod: request.method, headers: request.headers,
      multiValueHeaders: { cookie: request.headers.cookie?.split(";").map(value => value.trim()) },
      multiValueQueryStringParameters: parameters,
      body: Buffer.concat(chunks).toString("base64"), isBase64Encoded: true,
      requestContext: { identity: { sourceIp: "127.0.0.1" } } };
    let prelude = Buffer.alloc(0), headersSent = false;
    const stream = new Writable({
      write(chunk, encoding, callback) {
        try {
          if (headersSent) response.write(chunk);
          else {
            prelude = Buffer.concat([prelude, chunk]);
            const boundary = prelude.indexOf(delimiter);
            if (boundary < 0 && prelude.length > 64 * 1024) throw new Error("Fixture response headers too large");
            if (boundary >= 0) {
              const metadata = JSON.parse(prelude.subarray(0, boundary).toString("utf8"));
              response.writeHead(metadata.statusCode, { ...metadata.headers, ...(metadata.cookies?.length ? { "set-cookie": metadata.cookies } : {}) });
              headersSent = true; response.write(prelude.subarray(boundary + 8)); prelude = Buffer.alloc(0);
            }
          }
          callback();
        } catch (error) { callback(error); }
      },
      final(callback) { response.end(); callback(); },
    });
    stream.on("error", () => { if (!response.headersSent) response.writeHead(500); response.end(); });
    invocations++;
    await handler(event, stream, { callbackWaitsForEmptyEventLoop: false, getRemainingTimeInMillis: () => 60_000 });
  } catch { if (!response.headersSent) response.writeHead(500); response.end("Local Lambda invocation failed."); }
});
server.listen(Number(process.env.PORT), "127.0.0.1", () => process.send?.({ ready: true }));
process.on("SIGTERM", () => { server.close(); server.closeAllConnections(); process.send?.({ invocations }); process.exit(0); });
