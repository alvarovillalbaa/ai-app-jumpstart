import { createServer } from "node:http";
import { expect,it } from "vitest";
import { SupabaseRepository } from "../../lib/data/supabase";

async function listen(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve,reject) => {
    server.once("error",reject);
    server.listen(0,"127.0.0.1",resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected an HTTP test server port.");
  return address.port;
}

async function close(server: ReturnType<typeof createServer>) {
  if (!server.listening) return;
  const closed = new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  server.closeAllConnections();
  await closed;
}

it("does not forward the Supabase backend key across an HTTP redirect",async () => {
  let redirectedRequests = 0;
  let sourceRequests = 0;
  const destination = createServer((_request,response) => {
    redirectedRequests += 1;
    response.setHeader("content-type","application/json");
    response.end("[]");
  });
  const destinationPort = await listen(destination);
  const source = createServer((_request,response) => {
    sourceRequests += 1;
    if (sourceRequests === 1) {
      response.writeHead(302,{ location: `http://127.0.0.1:${destinationPort}/capture` });
      response.end();
      return;
    }
    response.setHeader("content-type","application/json");
    response.end("[]");
  });
  const sourcePort = await listen(source);
  try {
    const repository = new SupabaseRepository(`http://127.0.0.1:${sourcePort}`,"test-backend-secret-key");
    await expect(repository.list({ tenant: "test-org",subject: "alice" },{ limit: 10 })).resolves.toEqual({ items: [], nextCursor: null });
    expect(sourceRequests).toBeGreaterThan(1);
    expect(redirectedRequests).toBe(0);
  } finally {
    await close(source);
    await close(destination);
  }
});
