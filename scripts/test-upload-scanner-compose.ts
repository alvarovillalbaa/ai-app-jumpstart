import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod,mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { pingRemoteScanner,scanWithRemote } from "../lib/uploads/scanner";

const root = fileURLToPath(new URL("../",import.meta.url));
const script = fileURLToPath(import.meta.url);
const token = process.env.SCANNER_TEST_TOKEN ?? randomBytes(32).toString("base64url");
function command(executable: string,args: string[],env = process.env,timeout = 300_000): Promise<string> {
  return new Promise((resolve,reject) => {
    const child = spawn(executable,args,{ cwd: root,env,stdio: ["ignore","pipe","pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"),timeout);
    child.stdout.on("data",chunk => { output = (output + chunk).slice(-8000); });
    child.stderr.on("data",chunk => { output = (output + chunk).slice(-8000); });
    child.on("error",error => { clearTimeout(timer);reject(error); });
    child.on("close",(code,signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(output.trim());
      else reject(new Error(`${executable} failed (${signal ?? code}): ${output.replaceAll(token,"[redacted]")}`));
    });
  });
}

async function client() {
  const settings = { url: process.env.SCANNER_TEST_URL!,token };
  if (process.argv.includes("--unavailable")) {
    assert.equal(await pingRemoteScanner(settings),false);
    await assert.rejects(scanWithRemote(settings,Buffer.from("outage control")));
    console.log("Stopped ClamAV denies scans and readiness through trusted HTTPS.");
    return;
  }
  assert.equal(await pingRemoteScanner(settings),true);
  assert.equal(await scanWithRemote(settings,Buffer.from("Jumpstart clean scanner control.")),"clean");
  const eicar = Buffer.from(["X5O!P%@AP[4","\\","PZX54(P^)7CC)7}","$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""));
  assert.equal(eicar.length,68);
  assert.equal(await scanWithRemote(settings,eicar),"infected");
  assert.equal((await fetch(settings.url)).status,401);
  assert.equal((await fetch(settings.url,{ headers: { authorization: "Bearer wrong-token" } })).status,401);
  assert.equal((await fetch(settings.url.replace("/v1/scan","/other"))).status,404);
  const mismatch = await fetch(settings.url,{ method: "POST",body: "changed bytes",
    headers: { authorization: `Bearer ${token}`,"content-type": "application/octet-stream","x-content-sha256": "0".repeat(64) } });
  assert.equal(mismatch.status,400);
  const large = await fetch(settings.url,{ method: "POST",body: Buffer.alloc(5 * 1024 * 1024 + 1),
    headers: { authorization: `Bearer ${token}`,"content-type": "application/octet-stream","x-content-sha256": "0".repeat(64) } });
  assert.equal(large.status,413);
  console.log("Trusted HTTPS client passed real ClamAV clean/EICAR, auth, digest and body-limit controls.");
}

async function stackTest() {
  const project = `jumpstartscan${randomBytes(5).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-scanner-compose-"));
  const fixtureVolume = `${project}-fixtures`,initializer = `${project}-initializer`;
  const env = { ...process.env,SCANNER_GATEWAY_TOKEN: token,SCANNER_DOMAIN: "scanner.test" };
  let compose: (args: string[]) => Promise<string>,started = false;
  const docker = (...args: string[]) => command("docker",args,env);
  const files = ["-p",project,"-f","compose.upload-scanner.yaml","-f",join(directory,"override.yaml")];
  try {
    compose = await command("docker",["compose","version"]).then(() => (args: string[]) => command("docker",["compose",...args],env))
      .catch(async () => { await command("docker-compose",["version"]);return args => command("docker-compose",args,env); });
    const stack = (...args: string[]) => compose([...files,...args]);
    const listener = createServer();listener.listen(0,"127.0.0.1");
    await new Promise<void>(resolve => listener.once("listening",resolve));
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    const origin = `https://127.0.0.1:${port}/v1/scan`;
    // A one-use test trust root; never change NODE_TLS_REJECT_UNAUTHORIZED.
    await command("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-days","1",
      "-keyout",join(directory,"key.pem"),"-out",join(directory,"cert.pem"),"-subj","/CN=jumpstart-scanner-test",
      "-addext","subjectAltName=IP:127.0.0.1","-addext","basicConstraints=critical,CA:TRUE"]);
    await chmod(join(directory,"key.pem"),0o600);
    const caddy = (await readFile(join(root,"deploy/upload-scanner.Caddyfile"),"utf8"))
      .replace("{$SCANNER_DOMAIN}",":443").replace("  header X-Content-Type-Options","  tls /fixtures/cert.pem /fixtures/key.pem\n  header X-Content-Type-Options");
    await writeFile(join(directory,"Caddyfile"),caddy,{ mode: 0o600 });
    await writeFile(join(directory,"override.yaml"),`services:
  clamav:
    environment:
      CLAMAV_NO_FRESHCLAMD: "true"
  edge:
    ports: !override ["127.0.0.1:${port}:443"]
    command: [caddy, run, --config, /fixtures/Caddyfile, --adapter, caddyfile]
    volumes:
      - test-fixtures:/fixtures:ro
volumes:
  test-fixtures:
    external: true
    name: ${fixtureVolume}
`,{ mode: 0o600 });
    console.log("Building isolated scanner, gateway and HTTPS edge images...");
    await stack("build");
    await docker("volume","create",fixtureVolume);
    await docker("create","--name",initializer,"--user","0:0","--mount",`source=${fixtureVolume},target=/fixtures`,
      "node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6",
      "node","-e","for(const n of ['cert.pem','key.pem','Caddyfile'])require('fs').chownSync('/fixtures/'+n,1000,1000)");
    for (const name of ["cert.pem","key.pem","Caddyfile"]) await docker("cp",join(directory,name),`${initializer}:/fixtures/${name}`);
    await docker("start","--attach",initializer);
    started = true;
    await stack("up","--no-build","--wait","--wait-timeout","240","-d");
    const clientEnv = { ...process.env,SCANNER_TEST_TOKEN: token,SCANNER_TEST_URL: origin,NODE_EXTRA_CA_CERTS: join(directory,"cert.pem") };
    console.log(await command(process.execPath,["--import","tsx",script,"--client"],clientEnv,60_000));
    await assert.rejects(fetch(origin,{ signal: AbortSignal.timeout(3000) }),error =>
      ["DEPTH_ZERO_SELF_SIGNED_CERT","SELF_SIGNED_CERT_IN_CHAIN"].includes((error as Error & { cause?: { code?: string } }).cause?.code ?? ""),
    "The live HTTPS endpoint must reject an untrusted certificate");
    for (const service of ["gateway","clamav"]) {
      const id = await stack("ps","-q",service);
      const bindings = JSON.parse(await docker("inspect","--format","{{json .HostConfig.PortBindings}}",id));
      assert.ok(!bindings || Object.keys(bindings).length === 0,`${service} must have no published ports`);
    }
    const gatewayId = await stack("ps","-q","gateway");
    assert.equal(await docker("inspect","--format","{{.Config.User}}",gatewayId),"node");
    await stack("stop","clamav");
    console.log(await command(process.execPath,["--import","tsx",script,"--client","--unavailable"],clientEnv,60_000));
    console.log("Scanner Compose passed: private socket, non-root gateway, trusted TLS and fail-closed daemon outage.");
  } catch (error) {
    if (started) console.error((await compose!([...files,"logs","--no-color","--tail","25"]).catch(() => "")).replaceAll(token,"[redacted]"));
    throw error;
  } finally {
    let cleanupError: unknown;
    if (started) await compose!([...files,"down","--volumes","--remove-orphans"]).catch(error => { cleanupError = error; });
    await docker("rm","-f",initializer).catch(() => {});
    await docker("volume","rm",fixtureVolume).catch(() => {});
    await docker("image","rm",`${project}-clamav`,`${project}-gateway`,`${project}-edge`).catch(() => {});
    await rm(directory,{ recursive: true,force: true });
    if (cleanupError) throw cleanupError;
  }
}

try { if (process.argv.includes("--client")) await client(); else await stackTest(); }
catch (error) { console.error((error instanceof Error ? error.message : "Scanner Compose failed.").replaceAll(token,"[redacted]"));process.exitCode = 1; }
