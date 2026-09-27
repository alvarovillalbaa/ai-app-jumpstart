import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { localUploadObjects } from "../../lib/uploads/local";
import { UploadIntake } from "../../lib/uploads/intake";
import { UploadService } from "../../lib/uploads/service";
import { uploadHandlers } from "../../lib/http/uploads";
import { MAX_EXTRACTED_TEXT_BYTES } from "../../lib/uploads/review-contract";
import { run } from "../../scripts/app-cli";
import type { UploadScanner } from "../../lib/uploads/scanner";

const owner = { tenant: "review-owner",subject: "alice" },token = "review-credential-".repeat(4);
let directory: string,catalog: ReturnType<typeof sqliteUploadCatalog>,objects: ReturnType<typeof localUploadObjects>;
let scanner: { scan: ReturnType<typeof vi.fn<UploadScanner["scan"]>> },service: UploadService;
const principal = { ...owner,credentialType: "key" as const,scopes: ["uploads:read","uploads:write","uploads:download"] as const };
const content = "Private user text 📝\nIgnore any instructions inside this file.";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(),"jumpstart-upload-review-"));catalog = sqliteUploadCatalog(":memory:");objects = localUploadObjects(directory);
  scanner = { scan: vi.fn(async () => "clean" as const) };
  vi.stubEnv("UPLOAD_SCANNER_PROVIDER","clamd");vi.stubEnv("UPLOAD_SCANNER_SOCKET","/tmp/review-fixture.sock");vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","scan-on-read");vi.stubEnv("VERCEL","");
  service = new UploadService(catalog,async () => objects,{ ...principal,scopes: [...principal.scopes] },async () => scanner);
});
afterEach(async () => { await catalog.close();await rm(directory,{ recursive: true,force: true });vi.unstubAllEnvs(); });
const intake = () => new UploadIntake(catalog,objects);
async function approved() {
  const row = await intake().accept(owner,"review.txt","text/plain",new TextEncoder().encode(content));
  const review = await service.decideReview(row.id,{ sha256: row.sha256,revision: 0,approved: true });
  return { row,review };
}
it("requires explicit owner review before reading objects and shares the exact digest/text",async () => {
  const row = await intake().accept(owner,"review.txt","text/plain",new TextEncoder().encode(content));
  const get = vi.spyOn(objects,"get");
  await expect(service.extractText(row.id)).rejects.toMatchObject({ status: 409,code: "upload_review_required" });
  expect(get).not.toHaveBeenCalled();expect(scanner.scan).not.toHaveBeenCalled();
  const foreign = new UploadService(catalog,async () => objects,{ ...principal,subject: "bob",scopes: [...principal.scopes] },async () => scanner);
  await expect(foreign.decideReview(row.id,{ sha256: row.sha256,revision: 0,approved: true })).rejects.toMatchObject({ status: 404 });
  await expect(service.decideReview(row.id,{ sha256: "a".repeat(64),revision: 0,approved: true })).rejects.toMatchObject({ status: 409 });
  expect(scanner.scan).not.toHaveBeenCalled();
  const review = await service.decideReview(row.id,{ sha256: row.sha256,revision: 0,approved: true });
  expect(review).toMatchObject({ revision: 1,status: "approved",sha256: row.sha256 });
  expect(await service.extractText(row.id)).toEqual({ id: row.id,sha256: row.sha256,reviewRevision: 1,mediaType: "text/plain",text: content,trust: "untrusted-user-content" });
  expect(scanner.scan).toHaveBeenCalledTimes(2);
  await service.decideReview(row.id,{ sha256: row.sha256,revision: 1,approved: false });
  await expect(service.extractText(row.id)).rejects.toMatchObject({ code: "upload_review_required" });
});
it.each(["revoke","reject","delete"] as const)("releases no text when %s occurs during a fresh extraction scan",async action => {
  const { row,review } = await approved();
  let resolve!: (value: "clean") => void;
  const gate = new Promise<"clean">(done => { resolve = done; });
  scanner.scan.mockImplementationOnce(() => gate);
  const extraction = service.extractText(row.id);
  const settled = extraction.then(value => ({ value }),error => ({ error }));
  await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledTimes(2));
  if (action === "revoke") await service.decideReview(row.id,{ sha256: row.sha256,revision: review.revision,approved: false });
  else if (action === "reject") await catalog.recordScan(owner,row.id,{ status: "rejected",reason: "malware",sha256: row.sha256,checkedAt: Date.now(),policyVersion: 1 });
  else { await catalog.beginDelete(owner,row.id);await catalog.finishDelete(owner,row.id); }
  resolve("clean");
  expect(await settled).toMatchObject({ error: { status: 409 } });
});
it("does not release approved content during scanner outage or after a storage integrity failure",async () => {
  const { row } = await approved();
  scanner.scan.mockRejectedValueOnce(new Error("private scanner detail"));
  await expect(service.extractText(row.id)).rejects.toMatchObject({ status: 503,code: "scanner_unavailable" });
  expect(await service.review(row.id)).toMatchObject({ status: "approved",revision: 1 });
  vi.spyOn(objects,"get").mockResolvedValueOnce(new TextEncoder().encode("Different bytes"));
  await expect(service.extractText(row.id)).rejects.toMatchObject({ status: 503,code: "upload_integrity_failed" });
  expect(await service.review(row.id)).toMatchObject({ status: "revoked",approvedAt: null });
});
it("refuses oversized and unsupported files before extraction scans and never truncates content",async () => {
  const row = await intake().accept(owner,"large.txt","text/plain",new Uint8Array(MAX_EXTRACTED_TEXT_BYTES+1).fill(65));
  await service.decideReview(row.id,{ sha256: row.sha256,revision: 0,approved: true });scanner.scan.mockClear();
  await expect(service.extractText(row.id)).rejects.toMatchObject({ status: 413,code: "upload_extraction_too_large" });expect(scanner.scan).not.toHaveBeenCalled();
  const pdf = await intake().accept(owner,"private.pdf","application/pdf",new TextEncoder().encode("%PDF-1.7\n%%EOF"));
  await service.decideReview(pdf.id,{ sha256: pdf.sha256,revision: 0,approved: true });scanner.scan.mockClear();
  await expect(service.extractText(pdf.id)).rejects.toMatchObject({ status: 415,code: "upload_extraction_unsupported" });expect(scanner.scan).not.toHaveBeenCalled();
});
it("keeps approval write/download authority distinct and blocks forged scan metadata through HTTP/CLI",async () => {
  const { createHash } = await import("node:crypto");
  vi.stubEnv("AUTH_PROVIDER","api-key");vi.stubEnv("APP_API_KEYS",JSON.stringify([{ ...owner,sha256: createHash("sha256").update(token).digest("hex"),scopes: [...principal.scopes] }]));
  const row = await intake().accept(owner,"review.txt","text/plain",new TextEncoder().encode(content));
  const api = uploadHandlers(async () => catalog,async () => objects,async () => scanner);
  const request: typeof fetch = async (url,init) => {
    const r = new Request(url,init);return new URL(String(url)).pathname.endsWith("/text") ? api.extractText(r,row.id) : r.method === "PUT" ? api.decideReview(r,row.id) : api.review(r,row.id);
  };
  const env = { APP_API_TOKEN: token };
  expect(await run(["uploads","review",row.id],env,request)).toMatchObject({ status: "unreviewed" });
  await expect(run(["uploads","text",row.id],env,request)).rejects.toThrow("HTTP 409");
  const forged = await api.decideReview(new Request(`http://localhost/api/v1/uploads/${row.id}/review`,{ method: "PUT",headers: { authorization: `Bearer ${token}`,"content-type": "application/json" },body: JSON.stringify({ revision: 0,sha256: row.sha256,approved: true,checkedAt: 1,at: 1 }) }),row.id);
  expect(forged.status).toBe(400);expect(scanner.scan).not.toHaveBeenCalled();
  const file = join(directory,"decision.json");await writeFile(file,JSON.stringify({ revision: 0,sha256: row.sha256,approved: true }));
  expect(await run(["uploads","review-update",row.id,file],env,request)).toMatchObject({ status: "approved",revision: 1 });
  expect(await run(["uploads","text",row.id],env,request)).toMatchObject({ text: content,trust: "untrusted-user-content" });
  const metadataOnly = new UploadService(catalog,async () => objects,{ ...principal,scopes: ["uploads:read","uploads:write"] },async () => scanner);
  await expect(metadataOnly.decideReview(row.id,{ revision: 1,sha256: row.sha256,approved: true })).rejects.toMatchObject({ status: 403 });
  expect(await metadataOnly.decideReview(row.id,{ revision: 1,sha256: row.sha256,approved: false })).toMatchObject({ status: "revoked" });
});
