import { createServer, type Server } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { UploadIntake } from "../../lib/uploads/intake";
import { createUploadScanner, pingClamd, pingRemoteScanner, remoteScannerSettings, scanWithClamd, scanWithRemote } from "../../lib/uploads/scanner";
import { GET as scannerHealth } from "../../app/api/health/upload-scanner/route";
import { uploadHandlers } from "../../lib/http/uploads";
import { localUploadObjects } from "../../lib/uploads/local";
import { run } from "../../scripts/app-cli";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root,{ recursive: true,force: true })));
});

it("uses an authenticated HTTPS scanner for managed scan-on-read without releasing an unscanned byte",async () => {
  const settings = { UPLOAD_SCANNER_PROVIDER: "remote",UPLOAD_SCANNER_URL: "https://scanner.example.test/v1/scan",
    UPLOAD_SCANNER_TOKEN: "r".repeat(48) };
  const token = "managed-upload-owner-token-".repeat(3);
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("APP_API_KEYS",JSON.stringify([{ sha256: createHash("sha256").update(token).digest("hex"),
    tenant: "test",subject: "alice",scopes: ["uploads:read","uploads:write","uploads:download"] }]));
  for (const [key,value] of Object.entries(settings)) vi.stubEnv(key,value);
  vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","scan-on-read");
  vi.stubEnv("VERCEL","1");
  const scans: Uint8Array[] = [];
  vi.stubGlobal("fetch",vi.fn(async (url: string,init: RequestInit) => {
    expect(url).toBe(settings.UPLOAD_SCANNER_URL);
    expect(init.redirect).toBe("error");
    expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${settings.UPLOAD_SCANNER_TOKEN}`);
    const bytes = new Uint8Array(init.body as Buffer);
    expect(new Headers(init.headers).get("x-content-sha256")).toBe(createHash("sha256").update(bytes).digest("hex"));
    scans.push(bytes);
    return Response.json({ verdict: scans.length === 2 ? "infected" : "clean",
      sha256: createHash("sha256").update(bytes).digest("hex") });
  }));
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-managed-scanner-"));roots.push(directory);
  const catalog = sqliteUploadCatalog(":memory:"),objects = localUploadObjects(directory);
  const api = uploadHandlers(async () => catalog,async () => objects);
  try {
    const payload = "owner private text";
    const created = await api.create(new Request("http://localhost/api/v1/uploads",{ method: "POST",body: payload,
      headers: { authorization: `Bearer ${token}`,"content-type": "application/octet-stream",
        "x-upload-name": "note.txt","x-upload-media-type": "text/plain" } }));
    expect(created.status).toBe(201);
    const row = await created.json(),url = `http://localhost/api/v1/uploads/${row.id}/download`;
    const infected = await api.download(new Request(url,{ headers: { authorization: `Bearer ${token}` } }),row.id);
    expect(infected.status).toBe(422);
    expect((await infected.json()).error.code).toBe("upload_rejected");
    const clean = await api.download(new Request(url,{ headers: { authorization: `Bearer ${token}` } }),row.id);
    expect(clean.status).toBe(200);
    expect(await clean.text()).toBe(payload);
    expect(scans).toHaveLength(3);
    expect(scans.every(bytes => Buffer.from(bytes).toString() === payload)).toBe(true);
  } finally { await catalog.close(); }
});

it("rejects malformed remote scanner configuration and replies, and probes managed liveness",async () => {
  const valid = { UPLOAD_SCANNER_PROVIDER: "remote",UPLOAD_SCANNER_URL: "https://scanner.example.test/v1/scan",
    UPLOAD_SCANNER_TOKEN: "r".repeat(48) };
  for (const invalid of [
    { ...valid,UPLOAD_SCANNER_URL: "http://scanner.example.test/scan" },
    { ...valid,UPLOAD_SCANNER_URL: "https://user:pass@scanner.example.test/scan" },
    { ...valid,UPLOAD_SCANNER_URL: "https://scanner.example.test/scan?token=secret" },
    { ...valid,UPLOAD_SCANNER_URL: "https://127.0.0.1/scan" },
    { ...valid,UPLOAD_SCANNER_TOKEN: "short" },
    { ...valid,UPLOAD_CLAMD_SOCKET: "/run/clamd.sock" },
  ]) expect(() => remoteScannerSettings(invalid)).toThrow();
  const settings = remoteScannerSettings(valid);
  vi.stubGlobal("fetch",vi.fn(async (_url: string,init: RequestInit) => Response.json(init.method === "GET"
    ? { status: "ready" } : { verdict: "unknown" })));
  expect(await pingRemoteScanner(settings)).toBe(true);
  await expect(scanWithRemote(settings,Buffer.from("test"))).rejects.toThrow();
  vi.stubGlobal("fetch",vi.fn(async () => Response.json({ verdict: "clean",sha256: "0".repeat(64) })));
  await expect(scanWithRemote(settings,Buffer.from("test"))).rejects.toThrow("did not match");
  vi.stubGlobal("fetch",vi.fn(async () => Response.json({ verdict: "clean",
    sha256: createHash("sha256").update("test").digest("hex") },{ status: 201 })));
  await expect(scanWithRemote(settings,Buffer.from("test"))).rejects.toThrow("unavailable");
  vi.stubGlobal("fetch",vi.fn(async () => new Response("x".repeat(257),{ headers: { "content-type": "application/json" } })));
  await expect(scanWithRemote(settings,Buffer.from("test"))).rejects.toThrow("too large");
  for (const [key,value] of Object.entries(valid)) vi.stubEnv(key,value);
  vi.stubEnv("VERCEL","1");
  vi.stubGlobal("fetch",vi.fn(async () => Response.json({ status: "ready" })));
  const health = await scannerHealth();
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ status: "ready" });
});

it("uses a fresh socket verdict for each owner download through HTTP and CLI",async () => {
  const token = "upload-download-scanner-token-".repeat(3);
  vi.stubEnv("AUTH_PROVIDER","api-key");
  vi.stubEnv("APP_API_KEYS",JSON.stringify([{ sha256: createHash("sha256").update(token).digest("hex"),
    tenant: "test",subject: "alice",scopes: ["uploads:read","uploads:write","uploads:download"] }]));
  vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","scan-on-read");
  let scans = 0;
  vi.stubEnv("UPLOAD_SCANNER_PROVIDER","clamd");
  vi.stubEnv("UPLOAD_CLAMD_SOCKET",await daemon(() => ++scans === 2 ? "stream: Eicar-Test-Signature FOUND" : "stream: OK"));
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-download-integration-"));roots.push(directory);
  const catalog = sqliteUploadCatalog(":memory:"),objects = localUploadObjects(directory);
  const api = uploadHandlers(async () => catalog,async () => objects);
  try {
    const payload = "owner private text";
    const response = await api.create(new Request("http://localhost:3000/api/v1/uploads",{ method: "POST",body: payload,
      headers: { authorization: `Bearer ${token}`,"content-type": "application/octet-stream",
        "x-upload-name": "note.txt","x-upload-media-type": "text/plain" } }));
    expect(response.status).toBe(201);
    const row = await response.json(),url = `http://localhost:3000/api/v1/uploads/${row.id}/download`;
    const denied = await api.download(new Request(url,{ headers: { authorization: `Bearer ${token}` } }),row.id);
    expect(denied.status).toBe(422);
    expect((await denied.json()).error.code).toBe("upload_rejected");
    const output = join(directory,"owner.txt");
    const request: typeof fetch = async (input,init) => api.download(new Request(input,init),row.id);
    expect(await run(["uploads","download",row.id,output],{ APP_API_TOKEN: token },request))
      .toMatchObject({ file: output,size: payload.length });
    expect(await readFile(output,"utf8")).toBe(payload);
    expect(scans).toBe(3);
  } finally { await catalog.close(); }
});

async function daemon(reply: string | ((frame: Buffer) => string), observe: (frame: Buffer) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-clamd-")); roots.push(root);
  const path = join(root,"clamd.sock");
  const server = createServer(socket => {
    const chunks: Buffer[] = [];
    socket.on("data",chunk => {
      chunks.push(chunk);
      const frame = Buffer.concat(chunks);
      if (frame.length < 14 || frame.length < 18 + frame.readUInt32BE(10)) return;
      observe(frame);
      socket.end(Buffer.from(`${typeof reply === "string" ? reply : reply(frame)}\0`));
    });
  });
  servers.push(server);server.listen(path);await once(server,"listening");
  return path;
}

async function pingDaemon(reply: string,observe: (command: string) => void = () => {}) {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-clamd-ping-"));roots.push(root);
  const path = join(root,"clamd.sock");
  const server = createServer(socket => {
    socket.once("data",chunk => {
      observe(chunk.toString());
      socket.end(Buffer.from(reply));
    });
  });
  servers.push(server);server.listen(path);await once(server,"listening");
  return path;
}

it("reports scanner liveness separately from application readiness",async () => {
  vi.stubEnv("UPLOAD_SCANNER_PROVIDER","");
  vi.stubEnv("UPLOAD_CLAMD_SOCKET","");
  vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","");
  vi.stubEnv("VERCEL","");
  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME","");
  const disabled = await scannerHealth();
  expect(disabled.status).toBe(200);
  expect(await disabled.json()).toEqual({ status: "disabled",checks: { scanner: "disabled" } });
  let command = "";
  const path = await pingDaemon("PONG\0",value => { command = value; });
  vi.stubEnv("UPLOAD_SCANNER_PROVIDER","clamd");
  vi.stubEnv("UPLOAD_CLAMD_SOCKET",path);
  expect(await pingClamd(path)).toBe(true);
  const ready = await scannerHealth();
  expect(ready.status).toBe(200);
  expect(ready.headers.get("cache-control")).toBe("no-store");
  expect(await ready.json()).toEqual({ status: "ready",checks: { scanner: "ok" } });
  expect(command).toBe("zPING\0");
  vi.stubEnv("UPLOAD_SCANNER_URL","https://scanner.example.test/v1/scan");
  expect((await scannerHealth()).status).toBe(503);
  vi.stubEnv("UPLOAD_SCANNER_URL","");
  vi.stubEnv("VERCEL","1");
  const denied = await scannerHealth();
  expect(denied.status).toBe(503);
  expect(await denied.json()).toEqual({ status: "unavailable",checks: { scanner: "failed" } });
});

it("fails the scanner probe closed for partial config, missing sockets and malformed replies",async () => {
  vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","scan-on-read");
  vi.stubEnv("UPLOAD_SCANNER_PROVIDER","");
  vi.stubEnv("UPLOAD_CLAMD_SOCKET","");
  expect((await scannerHealth()).status).toBe(503);
  vi.stubEnv("UPLOAD_SCANNER_PROVIDER","clamd");
  vi.stubEnv("UPLOAD_CLAMD_SOCKET",join(tmpdir(),"missing-clamd.sock"));
  expect((await scannerHealth()).status).toBe(503);
  const path = await pingDaemon("NOPE\0");
  vi.stubEnv("UPLOAD_CLAMD_SOCKET",path);
  expect(await pingClamd(path)).toBe(false);
  expect((await scannerHealth()).status).toBe(503);
});

it("coalesces public scanner health bursts and expires the short probe cache",async () => {
  let probes = 0;
  const path = await pingDaemon("PONG\0",() => { probes++; });
  vi.stubEnv("UPLOAD_SCANNER_PROVIDER","clamd");
  vi.stubEnv("UPLOAD_CLAMD_SOCKET",path);
  vi.stubEnv("VERCEL","");
  vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME","");
  const now = Date.now(),clock = vi.spyOn(Date,"now").mockReturnValue(now);
  try {
    const burst = await Promise.all(Array.from({ length: 20 },() => scannerHealth()));
    expect(burst.every(response => response.status === 200)).toBe(true);
    expect(probes).toBe(1);
    expect((await scannerHealth()).status).toBe(200);
    expect(probes).toBe(1);
    clock.mockReturnValue(now + 5_001);
    expect((await scannerHealth()).status).toBe(200);
    expect(probes).toBe(2);
  } finally { clock.mockRestore(); }
});

it("streams exact bytes to clamd and accepts only a clean verdict",async () => {
  const payload = Buffer.from("private file bytes");
  let frame: Buffer | undefined;
  const path = await daemon("stream: OK",bytes => { frame = bytes; });
  expect(await scanWithClamd(path,payload)).toBe("clean");
  expect(frame?.subarray(0,10).toString()).toBe("zINSTREAM\0");
  expect(frame?.readUInt32BE(10)).toBe(payload.length);
  expect(frame?.subarray(14,14+payload.length)).toEqual(payload);
  expect(frame?.readUInt32BE(14+payload.length)).toBe(0);
  expect(frame?.length).toBe(18+payload.length);
});

it("treats infection as rejection and protocol errors as unavailable",async () => {
  const infected = await daemon("stream: Eicar-Test-Signature FOUND");
  expect(await scanWithClamd(infected,Buffer.from("test"))).toBe("infected");
  const broken = await daemon("stream: size limit exceeded ERROR");
  await expect(scanWithClamd(broken,Buffer.from("test"))).rejects.toThrow("valid verdict");
  await expect(scanWithClamd(join(tmpdir(),"missing-clamd.sock"),Buffer.from("test"))).rejects.toThrow("connection failed");
  await expect(createUploadScanner({ UPLOAD_SCANNER_PROVIDER: "clamd" })).rejects.toMatchObject({ status: 503,code: "scanner_unavailable" });
  expect(await createUploadScanner({})).toBeNull();
});

it("releases a scan-rejected reservation without writing bytes and keeps clean files quarantined",async () => {
  const catalog = sqliteUploadCatalog(":memory:");
  const owner = { tenant: "tenant",subject: "alice" };
  const objects = { put: vi.fn(async () => {}),get: vi.fn(async () => null),delete: vi.fn(async () => false) };
  const scan = vi.fn().mockResolvedValueOnce("infected").mockRejectedValueOnce(new Error("daemon unavailable")).mockResolvedValueOnce("clean");
  const intake = new UploadIntake(catalog,objects,{ maxBytes: 32,maxFiles: 1 },{ scan });
  try {
    await expect(intake.accept(owner,"infected.txt","text/plain",Buffer.from("test")))
      .rejects.toMatchObject({ status: 422,code: "upload_rejected" });
    expect(await catalog.usage(owner)).toEqual({ files: 0,bytes: 0 });
    await expect(intake.accept(owner,"unavailable.txt","text/plain",Buffer.from("test")))
      .rejects.toMatchObject({ status: 503,code: "scanner_unavailable" });
    expect(await catalog.usage(owner)).toEqual({ files: 0,bytes: 0 });
    expect(objects.put).not.toHaveBeenCalled();
    expect(objects.delete).not.toHaveBeenCalled();
    const row = await intake.accept(owner,"clean.txt","text/plain",Buffer.from("test"));
    expect(row.state).toBe("quarantined");
    expect(objects.put).toHaveBeenCalledOnce();
    expect(scan).toHaveBeenCalledTimes(3);
  } finally { await catalog.close(); }
});

it("runs the operator preflight with clean and EICAR controls",async () => {
  const samples: Buffer[] = [];
  const path = await daemon(frame => {
    const size = frame.readUInt32BE(10),sample = frame.subarray(14,14+size);
    samples.push(sample);
    return sample.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) ? "stream: Eicar-Test-Signature FOUND" : "stream: OK";
  });
  const child = spawn(process.execPath,["--import","tsx","scripts/check-upload-scanner.ts"],{
    cwd: process.cwd(),env: { ...process.env,UPLOAD_SCANNER_PROVIDER: "clamd",UPLOAD_CLAMD_SOCKET: path },stdio: ["ignore","pipe","pipe"],
  });
  let output = "";child.stdout.on("data",chunk => { output += chunk.toString(); });
  const [code] = await once(child,"exit");
  expect(code).toBe(0);
  expect(output).toContain("passed clean and EICAR controls");
  expect(samples).toHaveLength(2);
  expect(samples[1].length).toBe(68);
});
