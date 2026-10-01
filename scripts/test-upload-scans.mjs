import { createHash } from "node:crypto";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";

import { uploadScannerFixture } from "./helpers/upload-scanner-fixture.mjs";
const directory = await mkdtemp(join(tmpdir(),"jscan-"));
const control = join(directory,"verdict"),socketPath = join(directory,"scan.sock");
let web,scanner,output = "";
async function freePort() {
  const server = createServer();server.listen(0,"127.0.0.1");await once(server,"listening");
  const port = server.address().port;await new Promise(resolve => server.close(resolve));return port;
}
try {
  await writeFile(control,"clean",{ mode: 0o600 });
  scanner = await uploadScannerFixture(socketPath,control);
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
  await scanner?.stop();
  await rm(directory,{ recursive: true,force: true });
}
