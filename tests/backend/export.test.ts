import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { run } from "../../scripts/app-cli";
import { recordHandlers } from "../../lib/http/records";
import { SqliteRepository } from "../../lib/data/sqlite";

afterEach(() => vi.unstubAllEnvs());
const lines = async (path: string) => (await readFile(path, "utf8")).trim().split("\n").map(line => JSON.parse(line));

it("exports every paged record for one owner to a private file without replacing existing data", async () => {
  const token = "export-record-secret-".repeat(3);
  vi.stubEnv("APP_API_KEYS", JSON.stringify([{
    sha256: createHash("sha256").update(token).digest("hex"), tenant: "tenant", subject: "alice", scopes: ["records:read"],
  }]));
  const repository = new SqliteRepository(":memory:"), handler = recordHandlers(async () => repository);
  const directory = await mkdtemp(join(tmpdir(), "jumpstart-export-test-"));
  try {
    for (let index = 0; index < 105; index++) await repository.create({ tenant: "tenant", subject: "alice" }, { title: `Row ${index}`, content: "private" });
    await repository.create({ tenant: "tenant", subject: "bob" }, { title: "Foreign", content: "must stay private" });
    const request: typeof fetch = async (url, init) => handler.list(new Request(url, init));
    const output = join(directory, "records.ndjson"), env = { APP_API_TOKEN: token };
    expect(await run(["export", "records", output], env, request)).toMatchObject({ mode: "records", counts: { records: 105 } });
    const exported = await lines(output);
    expect(exported).toHaveLength(107);
    expect(exported[0].value).toMatchObject({ format: "ai-app-jumpstart-visible-data-v5", mode: "records" });
    expect(exported.filter(line => line.type === "record").map(line => line.value.title)).not.toContain("Foreign");
    expect(exported.at(-1).value.counts.records).toBe(105);
    expect((await stat(output)).mode & 0o077).toBe(0);
    await expect(run(["export", "records", output], env, request)).rejects.toThrow("already exists");
    expect(await lines(output)).toEqual(exported);
  } finally { await repository.close(); await rm(directory, { recursive: true, force: true }); }
});

it("exports visible account data, including archived conversations and paged projections", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jumpstart-export-account-"));
  const operation = randomUUID(), archivedOperation = randomUUID(), record = randomUUID(), artifact = randomUUID(), upload = randomUUID();
  const firstCorrection = randomUUID(),secondCorrection = randomUUID();
  const event = (id: string, index: number) => ({ schemaVersion: 1, eventId: id, at: "2026-09-24T10:00:00.000Z",
    turnId: "turn_0", sequence: 0, payload: { kind: "message", role: "user", parts: [{ type: "text", text: `part ${index}` }] }, ingestionIndex: index });
  const first = event("evt_01ARZ3NDEKTSV4RRFFQ69G5FAV", 1), second = event("evt_01ARZ3NDEKTSV4RRFFQ69G5FAW", 2);
  const conversation = (id: string, archived: boolean) => ({ id: randomUUID(), operationId: id, title: "Private chat",
    createdAt: 1, archived, revision: 1, status: "active" });
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer current-account-token");
    const path = new URL(String(url));
    if (path.pathname === "/api/v1/account/profile") return Response.json({ id: "0c9074e3-a19e-44ba-8931-8d1c84661297",
      email: "alice@example.test", phone: null, createdAt: "2026-09-24T10:00:00.000Z", updatedAt: null,
      lastSignInAt: null, emailConfirmedAt: null, phoneConfirmedAt: null, providers: ["email"], userMetadata: { displayName: "Alice" } });
    if (path.pathname === "/api/v1/usage") return Response.json({ day: 1, reservedMicros: 0, chargedMicros: 5,
      active: 0, recent: 0, unknownCosts: 0, dailyLimitMicros: 100 });
    if (path.pathname === "/api/v1/records") return Response.json({ items: [{ id: record, title: "Record", content: "private",
      revision: 1, createdAt: "2026-09-24T10:00:00.000Z", updatedAt: "2026-09-24T10:00:00.000Z" }], nextCursor: null });
    if (path.pathname === "/api/v1/conversations") return Response.json({
      items: [path.searchParams.get("archived") === "true" ? conversation(archivedOperation, true) : conversation(operation, false)], nextCursor: null,
    });
    if (path.pathname.endsWith("/events")) return Response.json({ schemaVersion: 1, source: "eve-stream",
      items: path.pathname.includes(archivedOperation) ? [] : path.searchParams.has("after") ? [second] : [first],
      nextCursor: path.pathname.includes(archivedOperation) || path.searchParams.has("after") ? null : 1 });
    if (path.pathname === "/api/v1/artifacts") return Response.json({ items: [{ id: artifact, operationId: operation,
      sourceSessionId: "session-1", sourceCallId: "call-1", title: "Note", content: "artifact text",
      mediaType: "text/plain", createdAt: 1 }], nextCursor: null });
    if (path.pathname === "/api/v1/uploads") return Response.json({ items: [{ id: upload, name: "private.txt",
      mediaType: "text/plain", size: 4, sha256: "a".repeat(64), createdAt: 1, state: "quarantined" }], usage: { files: 1, bytes: 4 } });
    if (path.pathname === "/api/v1/usage/reservations") return Response.json(path.searchParams.has("cursor")
      ? { items: [{ operationId: archivedOperation,createdAt: 2,day: 0,policyId: "policy-1",
        estimateMicros: 10,status: "reserved",actualMicros: null }],nextCursor: null }
      : { items: [{ operationId: operation,createdAt: 1,day: 0,policyId: "policy-1",
        estimateMicros: 10,status: "settled",actualMicros: 5 }],nextCursor: `1.${operation}` });
    if (path.pathname === "/api/v1/usage/corrections") return Response.json(path.searchParams.has("cursor")
      ? { items: [{ correctionId: secondCorrection,operationId: archivedOperation,
        previousActualMicros: 5,correctedActualMicros: 7,at: 2 }],nextCursor: null }
      : { items: [{ correctionId: firstCorrection,operationId: operation,
        previousActualMicros: null,correctedActualMicros: 5,at: 1 }],nextCursor: `1.${firstCorrection}` });
    throw new Error(`Unexpected export request: ${path.pathname}`);
  });
  try {
    const output = join(directory, "account.ndjson");
    expect(await run(["export", "application", output], { APP_API_TOKEN: "current-account-token" }, request)).toMatchObject({
      counts: { profile: 1, records: 1, conversations: 2, projections: 2, artifacts: 1, uploads: 1, uploadUsage: 1, reservations: 2, corrections: 2, usage: 1 },
    });
    const exported = await lines(output);
    expect(exported.map(line => line.type)).toEqual(["manifest", "account_profile", "record", "conversation", "projection", "projection", "conversation", "artifact", "upload", "upload_usage", "budget_reservation", "budget_reservation", "budget_correction", "budget_correction", "usage", "end"]);
    expect(exported.find(line => line.type === "account_profile")?.value).toMatchObject({ email: "alice@example.test", userMetadata: { displayName: "Alice" } });
    expect(exported[0].value.exclusions).toEqual(expect.arrayContaining([expect.stringContaining("Eve session/model history")]));
    expect(exported.find(line => line.type === "artifact")?.value.content).toBe("artifact text");
    expect(exported.find(line => line.type === "upload")?.value).toMatchObject({ id: upload, state: "quarantined" });
    expect(exported.find(line => line.type === "upload_usage")?.value).toEqual({ files: 1, bytes: 4 });
    expect(exported.find(line => line.type === "budget_reservation")?.value).toMatchObject({ operationId: operation,actualMicros: 5 });
    expect(exported.filter(line => line.type === "budget_reservation")[1].value).toMatchObject({ operationId: archivedOperation,status: "reserved" });
    expect(exported.filter(line => line.type === "budget_correction").map(line => line.value.correctionId)).toEqual([firstCorrection,secondCorrection]);
    expect(request.mock.calls[0]?.[0].toString()).toContain("/api/v1/account/profile");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("publishes no partial export when a later page fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jumpstart-export-failure-"));
  const cursor = randomUUID(), output = join(directory, "incomplete.ndjson");
  const request: typeof fetch = async (url) => {
    const path = new URL(String(url));
    if (path.searchParams.has("after")) return Response.json({ error: { code: "provider_unavailable" } }, { status: 503 });
    return Response.json({ items: [{ id: cursor, title: "One", content: "private", revision: 1,
      createdAt: "2026-09-24T10:00:00.000Z", updatedAt: "2026-09-24T10:00:00.000Z" }], nextCursor: cursor });
  };
  try {
    await expect(run(["export", "records", output], { APP_API_TOKEN: "owner-token" }, request)).rejects.toThrow("HTTP 503");
    expect(existsSync(output)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
