import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { UploadIntake } from "../../lib/uploads/intake";
import { createUploadScanner, scanWithClamd } from "../../lib/uploads/scanner";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root,{ recursive: true,force: true })));
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
