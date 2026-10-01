import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import { once } from "node:events";

/** Private real INSTREAM framing with controlled verdicts, not malware detection. */
export async function uploadScannerFixture(socketPath,control) {
  const sockets = new Set();
  const daemon = createServer(socket => {
    sockets.add(socket);socket.on("close",() => sockets.delete(socket));socket.on("error",() => {});
    socket.setTimeout(5000,() => socket.destroy());
    let frame = Buffer.alloc(0),done = false;
    socket.on("data",async chunk => {
      if (done) return;
      frame = Buffer.concat([frame,chunk]);
      if (frame.length > 5 * 1024 * 1024 + 1024) { done = true;socket.destroy();return; }
      if (frame.equals(Buffer.from("zPING\0"))) { done = true;socket.end("PONG\0");return; }
      if (frame.length < 10) return;
      if (!frame.subarray(0,10).equals(Buffer.from("zINSTREAM\0"))) { done = true;socket.destroy();return; }
      let offset = 10;
      while (offset+4 <= frame.length) {
        const length = frame.readUInt32BE(offset);offset += 4;
        if (length > 5 * 1024 * 1024) { done = true;socket.destroy();return; }
        if (!length) {
          done = true;
          const verdict = await readFile(control,"utf8").catch(() => "outage");
          if (verdict === "outage") socket.destroy();
          else socket.end(verdict === "infected" ? "stream: Fixture-Signature FOUND\0" : "stream: OK\0");
          return;
        }
        if (offset+length > frame.length) return;
        offset += length;
      }
    });
  });
  daemon.listen(socketPath);await once(daemon,"listening");
  return { async stop() {
    for (const socket of sockets) socket.destroy();
    if (daemon.listening) await new Promise(resolve => daemon.close(resolve));
  } };
}
