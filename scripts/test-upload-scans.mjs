import { createHash } from "node:crypto";
import { mkdtemp,readFile,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";

// Genuine INSTREAM framing with deterministic verdicts, not a malware engine.
// Production has no fixture hook: only this private daemon reads the control file.
const directory = await mkdtemp(join(tmpdir(),"jscan-"));
const control = join(directory,"verdict"),socketPath = join(directory,"scan.sock");
const sockets = new Set();
let web,output = "";
const daemon = createServer(socket => {
  sockets.add(socket);socket.on("close",() => sockets.delete(socket));
  socket.on("error",() => {});socket.setTimeout(5000,() => socket.destroy());
  let frame = Buffer.alloc(0),done = false;
  socket.on("data",async chunk => {
    if (done) return;
    frame = Buffer.concat([frame,chunk]);
    if (frame.length > 5 * 1024 * 1024 + 1024) { done = true;socket.destroy();return; }
    if (frame.equals(Buffer.from("zPING\0"))) { done = true;socket.end("PONG\0");return; }
    if (frame.length < 10) return;
    if (!frame.subarray(0,10).equals(Buffer.from("zINSTREAM\0"))) { done = true;socket.destroy();return; }
    let offset = 10;
    while (offset + 4 <= frame.length) {
      const length = frame.readUInt32BE(offset);offset += 4;
      if (length > 5 * 1024 * 1024) { done = true;socket.destroy();return; }
      if (length === 0) {
        done = true;
        const verdict = await readFile(control,"utf8");
        if (verdict === "outage") socket.destroy();
        else socket.end(verdict === "infected" ? "stream: Fixture-Signature FOUND\0" : "stream: OK\0");
        return;
      }
      if (offset + length > frame.length) return;
      offset += length;
    }
  });
});
async function freePort() {
  const server = createServer();server.listen(0,"127.0.0.1");await once(server,"listening");
  const port = server.address().port;await new Promise(resolve => server.close(resolve));return port;
}
try {
  await writeFile(control,"clean",{ mode: 0o600 });
  daemon.listen(socketPath);await once(daemon,"listening");
  const port = await freePort(),origin = `http://127.0.0.1:${port}`;
  // Allow only runtime essentials from the operator environment. Next will load
  // .env files, so explicitly override every setting relevant to these paths.
  const env = Object.fromEntries(["PATH","HOME","TMPDIR","SystemRoot","CI"].filter(key => process.env[key]).map(key => [key,process.env[key]]));
  Object.assign(env,{
    NODE_ENV: "production",AUTH_PROVIDER: "api-key",APP_ORIGIN: origin,AI_CHAT_ENABLED: "false",
    DATA_PROVIDER: "sqlite",SQLITE_PATH: join(directory,"catalog.sqlite"),UPLOAD_STORAGE_PROVIDER: "local",
    UPLOAD_LOCAL_ROOT: join(directory,"objects"),UPLOAD_DOWNLOAD_POLICY: "scan-on-read",UPLOAD_SCANNER_PROVIDER: "clamd",
    UPLOAD_CLAMD_SOCKET: socketPath,UPLOAD_SCANNER_URL: "",UPLOAD_SCANNER_TOKEN: "",VERCEL: "",AWS_LAMBDA_FUNCTION_NAME: "",
    UPLOAD_DOWNLOAD_SIGNING_JSON: JSON.stringify({ audience: "isolated-upload-browser",activeKey: "fixture",keys: { fixture: "a".repeat(64) } }),
    APP_API_KEYS: JSON.stringify([
      ["owner","owner",["uploads:read","uploads:write","uploads:download"]],
      ["other","other",["uploads:read","uploads:write","uploads:download"]],
      ["metadata","owner",["uploads:read","uploads:write"]],
    ].map(([label,subject,scopes]) => ({ sha256: createHash("sha256").update(`upload-scan-fixture-${label}-`.repeat(3)).digest("hex"),tenant: "scan-test",subject,scopes }))),
  });
  web = spawn(process.execPath,["node_modules/next/dist/bin/next","start","--hostname","127.0.0.1","--port",String(port)],{
    env,stdio: ["ignore","pipe","pipe"],
  });
  for (const stream of [web.stdout,web.stderr]) stream.on("data",chunk => { output = (output + chunk).slice(-6000); });
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline && web.exitCode === null) {
    if (await fetch(`${origin}/api/health/live`,{ signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)) { ready = true;break; }
    await new Promise(resolve => setTimeout(resolve,200));
  }
  if (!ready) throw new Error(`Isolated scan test app failed to start: ${output}`);
  const tests = spawn(process.execPath,["node_modules/@playwright/test/cli.js","test","--config","playwright.upload-scans.config.ts"],{
    env: { ...env,TEST_UPLOAD_SCAN_ORIGIN: origin,TEST_UPLOAD_SCAN_CONTROL: control },stdio: "inherit",
  });
  const [code,signal] = await once(tests,"exit");
  if (code !== 0 || signal) throw new Error(`Upload scan browser contract failed (${signal ?? code}).`);
  console.log("Production browser scan decisions passed with an isolated protocol fixture.");
} finally {
  if (web?.exitCode === null) {
    web.kill("SIGTERM");
    await Promise.race([once(web,"exit"),new Promise(resolve => setTimeout(resolve,3000))]);
    if (web.exitCode === null) { web.kill("SIGKILL");await once(web,"exit"); }
  }
  for (const socket of sockets) socket.destroy();
  if (daemon.listening) await new Promise(resolve => daemon.close(resolve));
  await rm(directory,{ recursive: true,force: true });
}
