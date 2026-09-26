import { createHash } from "node:crypto";
import { createServer,type Socket } from "node:net";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach,expect,it,vi } from "vitest";
import { createScannerGateway } from "../../deploy/upload-scanner-gateway.mjs";
import { pingRemoteScanner,scanWithRemote } from "../../lib/uploads/scanner";

afterEach(() => vi.unstubAllGlobals());

it("binds HTTPS-client verdicts to exact bytes through the authenticated gateway and ClamAV protocol",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-scanner-gateway-"));
  const socketPath = join(directory,"clamd.sock"),token = "g".repeat(48);
  const commands: string[] = [];
  let hold = false;
  const waiting: Socket[] = [];
  const connections = new Set<Socket>();
  const daemon = createServer(socket => {
    connections.add(socket);socket.on("close",() => connections.delete(socket));
    let frame = Buffer.alloc(0);
    socket.on("data",chunk => {
      frame = Buffer.concat([frame,chunk]);
      if (frame.equals(Buffer.from("zPING\0"))) { commands.push("ping");socket.end("PONG\0");return; }
      if (frame.length < 18 || frame.subarray(0,10).toString() !== "zINSTREAM\0") return;
      const size = frame.readUInt32BE(10);
      if (frame.length !== 18 + size) return;
      const bytes = frame.subarray(14,14+size);
      commands.push(bytes.toString());
      if (hold) { waiting.push(socket);return; }
      socket.end(bytes.toString().includes("infected") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
    });
  });
  daemon.listen(socketPath);await once(daemon,"listening");
  const gateway = createScannerGateway({ token,socketPath });
  gateway.listen(0,"127.0.0.1");await once(gateway,"listening");
  const port = (gateway.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}/v1/scan`;
  const realFetch = globalThis.fetch;
  const settings = { url: "https://scanner.example.test/v1/scan",token };
  try {
    expect((await realFetch(origin)).status).toBe(401);
    vi.stubGlobal("fetch",(url: string,init: RequestInit) => realFetch(url === settings.url ? origin : url,init));
    expect(await pingRemoteScanner(settings)).toBe(true);
    expect(await scanWithRemote(settings,Buffer.from("clean bytes"))).toBe("clean");
    expect(await scanWithRemote(settings,Buffer.from("infected bytes"))).toBe("infected");
    const mismatched = await realFetch(origin,{ method: "POST",body: Buffer.from("changed"),
      headers: { authorization: `Bearer ${token}`,"content-type": "application/octet-stream",
        "x-content-sha256": createHash("sha256").update("other").digest("hex") } });
    expect(mismatched.status).toBe(400);
    expect(commands).toEqual(["ping","clean bytes","infected bytes"]);
    const tooLarge = await realFetch(origin,{ method: "POST",body: Buffer.alloc(5 * 1024 * 1024 + 1),
      headers: { authorization: `Bearer ${token}`,"content-type": "application/octet-stream","x-content-sha256": "0".repeat(64) } });
    expect(tooLarge.status).toBe(413);
    hold = true;
    const active = Array.from({ length: 4 },() => scanWithRemote(settings,Buffer.from("bounded scan")));
    await vi.waitFor(() => expect(waiting).toHaveLength(4));
    const saturated = await realFetch(origin,{ method: "POST",body: Buffer.from("test"),
      headers: { authorization: `Bearer ${token}`,"content-type": "application/octet-stream",
        "x-content-sha256": createHash("sha256").update("test").digest("hex") } });
    expect(saturated.status).toBe(429);
    for (const socket of waiting) socket.end("stream: OK\0");
    expect(await Promise.all(active)).toEqual(["clean","clean","clean","clean"]);
  } finally {
    gateway.closeAllConnections();
    for (const socket of connections) socket.destroy();
    await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())),
      new Promise<void>(resolve => daemon.close(() => resolve()))]);
    await rm(directory,{ recursive: true,force: true });
  }
});
