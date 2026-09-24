import { createServer } from "node:http";

createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/eve/v1/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ready", query: url.searchParams.get("probe") }));
    return;
  }
  if (url.pathname === "/.well-known/workflow/v1/flow" && request.method === "POST") {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ body, query: url.searchParams.get("probe"),
      authorizationForwarded: request.headers.authorization === "Bearer probe-only-token",
      cookieForwarded: request.headers.cookie === "probe_session=opaque" }));
    return;
  }
  if (url.pathname === "/eve/v1/session/probe/stream") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.write("data: first\n\n");
    setTimeout(() => response.end("data: second\n\n"), 500);
    return;
  }
  response.writeHead(404).end();
}).listen(4274, "127.0.0.1");
