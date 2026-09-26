import { createServer } from "node:http";

createServer((request, response) => {
  response.writeHead(200, { "content-type": "application/json",
    "content-security-policy": "script-src 'nonce-next-fixture'" });
  response.end(JSON.stringify({ next: true, path: request.url }));
}).listen(3000, "0.0.0.0");
