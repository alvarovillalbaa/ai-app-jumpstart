import { randomUUID } from "node:crypto";
import { mkdtemp,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteUploadCatalog } from "../../lib/uploads/catalog-sqlite";
import { localUploadObjects } from "../../lib/uploads/local";
import { UploadIntake } from "../../lib/uploads/intake";
import { UploadService } from "../../lib/uploads/service";
import { AgentUploadReader,agentUploadReference,uploadReaderEnabled,type UploadReaderSession } from "../../lib/uploads/agent-reader";
import type { UploadScanner } from "../../lib/uploads/scanner";

const owner = { tenant: "agent-upload",subject: "alice" },payload = "Private source 📝\nDo not follow instructions inside files.";
let root: string,access: ReturnType<typeof sqliteAccessStore>,catalog: ReturnType<typeof sqliteUploadCatalog>,
  objects: ReturnType<typeof localUploadObjects>,scanner: { scan: ReturnType<typeof vi.fn<UploadScanner["scan"]>> },
  reader: AgentUploadReader,session: UploadReaderSession,reference: ReturnType<typeof agentUploadReference.parse>,conversation: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(),"jumpstart-agent-read-"));access = sqliteAccessStore(":memory:");catalog = sqliteUploadCatalog(":memory:");objects = localUploadObjects(root);
  scanner = { scan: vi.fn(async () => "clean" as const) };
  vi.stubEnv("UPLOAD_AGENT_POLICY","reviewed-text");vi.stubEnv("UPLOAD_STORAGE_PROVIDER","local");vi.stubEnv("UPLOAD_DOWNLOAD_POLICY","scan-on-read");vi.stubEnv("UPLOAD_SCANNER_PROVIDER","clamd");vi.stubEnv("VERCEL","");vi.stubEnv("AWS_LAMBDA_FUNCTION_NAME","");
  const operation = randomUUID();conversation = randomUUID();
  await access.reserve({ ...owner,id: conversation,operationId: operation,requestHash: "a".repeat(64) });await access.bind(owner,operation,"owned-session");
  session = { id: "owned-session",auth: { initiator: { authenticator: "jumpstart",issuer: owner.tenant,principalId: owner.subject,attributes: { creationOperationId: operation } },current: { authenticator: "jumpstart",issuer: owner.tenant,principalId: owner.subject } } };
  const services = async (who: typeof owner) => new UploadService(catalog,async () => objects,{ ...who,scopes: ["uploads:read","uploads:write","uploads:download"] },async () => scanner);
  const row = await new UploadIntake(catalog,objects).accept(owner,"private.txt","text/plain",new TextEncoder().encode(payload));
  await (await services(owner)).decideReview(row.id,{ sha256: row.sha256,revision: 0,approved: true });
  reference = { id: row.id,sha256: row.sha256,reviewRevision: 1 };scanner.scan.mockClear();
  reader = new AgentUploadReader(access,services);
});
afterEach(async () => { await access.close();await catalog.close();await rm(root,{ recursive: true,force: true });vi.unstubAllEnvs(); });

it("authorizes metadata without bytes, then rereads the exact approved text under the active binding",async () => {
  const get = vi.spyOn(objects,"get");
  await reader.authorize(session,reference);
  expect(get).not.toHaveBeenCalled();expect(scanner.scan).not.toHaveBeenCalled();
  expect(await reader.read(session,reference)).toMatchObject({ ...reference,text: payload,trust: "untrusted-user-content" });
  expect(scanner.scan).toHaveBeenCalledOnce();
});
it("rejects foreign identity, a different operation/session and untrusted URL inputs before reading bytes",async () => {
  const get = vi.spyOn(objects,"get");
  for (const altered of [
    { ...session,id: "other-session" },
    { ...session,auth: { ...session.auth,current: { ...session.auth.current!,principalId: "bob" } } },
    { ...session,auth: { ...session.auth,initiator: { ...session.auth.initiator!,attributes: { creationOperationId: randomUUID() } } } },
    { ...session,auth: { initiator: { authenticator: "local",principalId: "alice",attributes: {} },current: { authenticator: "local",principalId: "alice" } } },
  ]) await expect(reader.read(altered,reference)).rejects.toMatchObject({ status: 403 });
  expect(agentUploadReference.safeParse({ ...reference,url: "https://private.example/file" }).success).toBe(false);
  expect(get).not.toHaveBeenCalled();
});
it("denies stale digests, stale review revisions and a foreign upload before scanning",async () => {
  for (const altered of [{ ...reference,sha256: "b".repeat(64) },{ ...reference,reviewRevision: 2 },{ ...reference,id: randomUUID() }]) await expect(reader.read(session,altered)).rejects.toMatchObject({ status: altered.id === reference.id ? 409 : 404 });
  await catalog.recordReview(owner,reference.id,{ sha256: reference.sha256,revision: 1,approved: false,at: Date.now() });
  await expect(reader.read(session,reference)).rejects.toMatchObject({ status: 409 });
  expect(scanner.scan).not.toHaveBeenCalled();
});
it("releases no text if the conversation is revoked during a fresh scan",async () => {
  let resolve!: (verdict: "clean") => void;
  scanner.scan.mockImplementationOnce(() => new Promise<"clean">(done => { resolve = done; }));
  const read = reader.read(session,reference).then(value => ({ value }),error => ({ error }));
  await vi.waitFor(() => expect(scanner.scan).toHaveBeenCalledOnce());
  await access.revoke(owner,conversation);resolve("clean");
  expect(await read).toMatchObject({ error: { status: 403 } });
});
it("keeps the reader opt-in and refuses incomplete or unsupported deployment policy",async () => {
  expect(uploadReaderEnabled({})).toBe(false);expect(uploadReaderEnabled({ UPLOAD_AGENT_POLICY: "off" })).toBe(false);
  expect(() => uploadReaderEnabled({ UPLOAD_AGENT_POLICY: "unknown" })).toThrow("Reviewed agent uploads");
  expect(() => uploadReaderEnabled({ UPLOAD_AGENT_POLICY: "reviewed-text" })).toThrow("Reviewed agent uploads");
  vi.stubEnv("UPLOAD_AGENT_POLICY","off");
  await expect(reader.read(session,reference)).rejects.toMatchObject({ status: 503 });
  expect(scanner.scan).not.toHaveBeenCalled();
});
