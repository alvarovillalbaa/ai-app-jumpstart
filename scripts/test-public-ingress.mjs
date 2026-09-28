import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const suffix = randomUUID().slice(0, 12);
const app = `jumpstart-public-app-${suffix}`;
const ingress = `jumpstart-public-ingress-${suffix}`;
const dataVolume = `jumpstart-public-data-${suffix}`;
const configVolume = `jumpstart-public-config-${suffix}`;
const directory = await mkdtemp(join(tmpdir(), "jumpstart-public-ingress-"));
const composeDirectory = join(directory,"compose");
const rootCert = join(directory, "root.crt");
const caddyImage = "caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
const nodeImage = "node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6";
function compose(args) {
  let executable = "docker",prefix = ["compose"];
  try { execFileSync(executable,[...prefix,"version"],{ stdio: "ignore" }); }
  catch { executable = "docker-compose";prefix = []; }
  return execFileSync(executable,[...prefix,...args],{
    encoding: "utf8",timeout: 30_000,stdio: ["ignore","pipe","pipe"],
    cwd: composeDirectory,
    env: { ...process.env,APP_DOMAIN: "example.com",POSTGRES_PASSWORD: "fixture-only-compose-check" },
  });
}
function checkCompose(withPostgres) {
  const files = ["compose.yaml",...(withPostgres ? ["compose.postgres.yaml"] : []),
    "compose.streaming.yaml","compose.public-https.yaml"];
  const config = JSON.parse(compose([...files.flatMap(file => ["-f",file]),
    "config","--no-env-resolution","--format","json"]));
  assert.deepEqual(config.services.app.ports ?? [],[],"app port must stay private");
  assert.equal(config.services.app.environment.APP_ORIGIN,"https://example.com");
  assert.deepEqual(config.services.ingress.ports.map(port => port.published).sort(),["443","80"]);
  const mounts = config.services.ingress.volumes.map(volume => volume.target);
  for (const target of ["/etc/caddy/Caddyfile","/etc/caddy/split-app-routes.Caddyfile","/data","/config"])
    assert.ok(mounts.includes(target),`ingress must mount ${target}`);
}
function docker(...args) { return execFileSync("docker", args, {
  encoding: "utf8",timeout: 180_000,stdio: ["ignore","pipe","pipe"],
}).trim(); }
function cleanup(...args) { try { docker(...args); } catch { /* disposable resource cleanup */ } }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function request(protocol,port,path,ca,headers = {}) {
  return new Promise((resolve,reject) => {
    const send = protocol === "https" ? httpsRequest : httpRequest;
    const req = send({ hostname: "localhost",family: 4,servername: "localhost",port,path,
      headers: { host: "localhost",...headers },...(ca ? { ca } : {}) },res => {
      const chunks = [];
      res.on("data",chunk => chunks.push(chunk));
      res.on("end",() => resolve({ status: res.statusCode,headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error",reject);
    });
    req.setTimeout(5000,() => req.destroy(new Error("Ingress request timed out.")));
    req.on("error",reject);req.end();
  });
}
function stream(port,ca) {
  return new Promise((resolve,reject) => {
    const pieces = [];
    const req = httpsRequest({ hostname: "localhost",family: 4,servername: "localhost",port,
      path: "/eve/v1/session/probe/stream",ca },res => {
      if (res.statusCode !== 200) { reject(new Error("Eve stream route failed."));res.resume();return; }
      res.on("data",chunk => {
        pieces.push({ text: chunk.toString("utf8"),at: Date.now() });
        if (pieces.length === 2) { res.destroy();resolve(pieces); }
      });
      res.on("end",() => { if (pieces.length < 2) reject(new Error("Eve stream ended early.")); });
      res.on("error",reject);
    });
    req.setTimeout(5000,() => req.destroy(new Error("Eve stream timed out.")));
    req.on("error",reject);req.end();
  });
}
async function waitForRoot() {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      docker("cp",`${ingress}:/data/caddy/pki/authorities/local/root.crt`,rootCert);
      return await readFile(rootCert);
    } catch { await delay(200); }
  }
  throw new Error("Caddy did not provision its local test CA.");
}
function startIngress() {
  docker("run","--detach","--rm","--network",`container:${app}`,"--name",ingress,
    "--entrypoint","caddy","--env","APP_DOMAIN=localhost",
    "--env","NEXT_UPSTREAM=127.0.0.1:3000","--env","EVE_UPSTREAM=127.0.0.1:4274",
    "--mount",`type=bind,source=${resolve("deploy/public-app.Caddyfile")},target=/etc/caddy/Caddyfile,readonly`,
    "--mount",`type=bind,source=${resolve("deploy/split-app-routes.Caddyfile")},target=/etc/caddy/split-app-routes.Caddyfile,readonly`,
    "--mount",`type=volume,source=${dataVolume},target=/data`,
    "--mount",`type=volume,source=${configVolume},target=/config`,
    caddyImage,"run","--config","/etc/caddy/Caddyfile");
}

let stage = "setup";
try {
  mkdirSync(composeDirectory);mkdirSync(join(composeDirectory,"deploy"));
  for (const file of ["compose.yaml","compose.postgres.yaml","compose.streaming.yaml","compose.public-https.yaml"])
    copyFileSync(resolve(file),join(composeDirectory,file));
  for (const file of ["split-app.Caddyfile","split-app-routes.Caddyfile","public-app.Caddyfile"])
    copyFileSync(resolve("deploy",file),join(composeDirectory,"deploy",file));
  writeFileSync(join(composeDirectory,".env.local"),"",{ mode: 0o600 });
  checkCompose(false);checkCompose(true);
  docker("volume","create",dataVolume);docker("volume","create",configVolume);
  docker("run","--detach","--rm","--name",app,"--publish","127.0.0.1::80","--publish","127.0.0.1::443",
    "--mount",`type=bind,source=${resolve("scripts/fixtures/split-eve-upstream.mjs")},target=/eve.mjs,readonly`,
    "--mount",`type=bind,source=${resolve("scripts/fixtures/split-next-upstream.mjs")},target=/next.mjs,readonly`,
    nodeImage,"node","--input-type=module","-e","await import('/eve.mjs'); await import('/next.mjs')");
  startIngress();
  const httpPort = Number(docker("port",app,"80/tcp").split(":").at(-1));
  const httpsPort = Number(docker("port",app,"443/tcp").split(":").at(-1));
  assert.ok(httpPort > 0 && httpsPort > 0);
  stage = "certificate";
  const ca = await waitForRoot();
  let health;
  for (let attempt = 0; attempt < 30; attempt++) {
    health = await request("https",httpsPort,"/eve/v1/health?probe=public",ca).catch(() => null);
    if (health?.status === 200) break;
    await delay(200);
  }
  assert.equal(health?.status,200,"trusted HTTPS Eve health must be reachable");
  assert.deepEqual(JSON.parse(health.body),{ status: "ready",query: "public" });
  assert.equal(health.headers["strict-transport-security"],"max-age=31536000");
  assert.equal(health.headers["cache-control"],"no-store");
  stage = "routing";
  const page = await request("https",httpsPort,"/records?probe=public",ca);
  assert.equal(page.status,200);
  assert.deepEqual(JSON.parse(page.body),{ next: true,path: "/records?probe=public" });
  assert.equal(page.headers["content-security-policy"],"script-src 'nonce-next-fixture'");
  const redirected = await request("http",httpPort,"/records");
  assert.equal(redirected.status,308);
  assert.match(redirected.headers.location ?? "",/^https:\/\/localhost\/records$/);
  try {
    const denied = await request("https",httpsPort,"/records",ca,{ host: "wrong.example" });
    assert.equal(denied.status,421,"mismatched Host and TLS SNI must not reach the app");
  } catch (error) {
    assert.equal(error.code,"ECONNRESET","only a closed connection is an acceptable alternative to 421");
  }
  stage = "streaming";
  const pieces = await stream(httpsPort,ca);
  assert.deepEqual(pieces.map(piece => piece.text),["data: first\n\n","data: second\n\n"]);
  assert.ok(pieces[1].at-pieces[0].at >= 250,"TLS ingress must flush the first SSE event before the second");
  const rootDigest = createHash("sha256").update(ca).digest("hex");
  stage = "replacement";
  docker("rm","--force",ingress);
  startIngress();
  const after = await waitForRoot();
  assert.equal(createHash("sha256").update(after).digest("hex"),rootDigest,"certificate CA must survive ingress replacement");
  let restored;
  for (let attempt = 0; attempt < 30; attempt++) {
    restored = await request("https",httpsPort,"/api/health/ready",after).catch(() => null);
    if (restored?.status === 200) break;
    await delay(200);
  }
  assert.equal(restored?.status,200,"trusted HTTPS must recover after ingress replacement");
  console.log("Public ingress passed: trusted local HTTPS, redirect, host isolation, Next/Eve routing, live SSE and persisted certificate CA.");
} catch (error) {
  console.error(`Public ingress test failed during ${stage}.`);
  throw error;
} finally {
  cleanup("rm","--force",ingress);cleanup("rm","--force",app);
  cleanup("volume","rm",configVolume);cleanup("volume","rm",dataVolume);
  await rm(directory,{ recursive: true,force: true });
}
