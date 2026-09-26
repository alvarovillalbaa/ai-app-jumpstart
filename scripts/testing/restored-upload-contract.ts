import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { Client } from "pg";
import { z } from "zod";
import { postgresUploadCatalog } from "../../lib/uploads/catalog-remote";
import { localUploadObjects } from "../../lib/uploads/local";
import { uploadObjectKey } from "../../lib/uploads/contract";
import { UploadIntake } from "../../lib/uploads/intake";
import { uploadHandlers } from "../../lib/http/uploads";

// Disposable PostgreSQL backup harness only: no runtime hooks or model calls.
const url = new URL(process.env.DATABASE_URL!);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
assert.ok(url.pathname.endsWith("_test"));
const root = process.env.RESTORED_UPLOAD_ROOT!, fixtureFile = process.env.RESTORED_UPLOAD_FIXTURE!;
assert.ok(isAbsolute(root) && isAbsolute(fixtureFile));
const alice = { tenant: "backup-tenant", subject: "alice" }, bob = { ...alice, subject: "bob" };
const payload = new TextEncoder().encode("private restored upload bytes\n");
const catalog = postgresUploadCatalog(url.href), objects = localUploadObjects(root);
const ids = z.object({ quarantined: z.uuid(), clean: z.uuid(), malware: z.uuid(), integrity: z.uuid(), bob: z.uuid(), pending: z.uuid(), deleting: z.uuid(), deleted: z.uuid() }).strict();
try {
  if (process.argv[2] === "--seed") {
    const intake = new UploadIntake(catalog, objects);
    const accepted = async (owner = alice) => (await intake.accept(owner, "private.txt", "text/plain", payload)).id;
    const fixture = { quarantined: await accepted(), clean: await accepted(), malware: await accepted(), integrity: await accepted(),
      bob: await accepted(bob), pending: randomUUID(), deleting: randomUUID(), deleted: randomUUID() };
    const sha256 = createHash("sha256").update(payload).digest("hex");
    for (const [id, status, reason] of [[fixture.clean, "clean", undefined], [fixture.malware, "rejected", "malware"], [fixture.integrity, "rejected", "integrity"]] as const) {
      const decision = status === "clean" ? { status, sha256, checkedAt: 1, policyVersion: 1 as const }
        : { status, sha256, checkedAt: 1, policyVersion: 1 as const, reason: reason! };
      assert.equal(await catalog.recordScan(alice, id, decision), true);
    }
    // Retain corrupt evidence; a restored integrity rejection must stay terminal.
    await writeFile(join(root, uploadObjectKey(alice, fixture.integrity)), "corrupt retained evidence");
    for (const id of [fixture.pending, fixture.deleting, fixture.deleted]) {
      assert.equal(await catalog.reserve(alice, { id, name: "private.txt", mediaType: "text/plain", size: payload.length, sha256, createdAt: 1 },
        { maxFiles: 20, maxBytes: 1_000_000 }), "reserved");
    }
    assert.equal(await catalog.beginDelete(alice, fixture.deleting), true);
    assert.equal(await catalog.beginDelete(alice, fixture.deleted), true);
    assert.equal(await catalog.finishDelete(alice, fixture.deleted), true);
    // Force the snapshot catalog validator past its 500-row page boundary.
    const client = new Client({ connectionString: url.href }); await client.connect();
    try { await client.query(`INSERT INTO app_uploads(id,tenant,subject,name,media_type,size,sha256,created_at,state)
      SELECT gen_random_uuid(),'backup-tenant','past-owner','deleted.txt','text/plain',1,$1,1,'deleted' FROM generate_series(1,501)`, [sha256]); }
    finally { await client.end(); }
    await writeFile(fixtureFile, JSON.stringify(ids.parse(fixture)), { mode: 0o600, flag: "wx" });
    console.log("Seeded private upload backup fixtures through the production catalog/object services.");
  } else {
    assert.equal(process.argv[2], "--verify");
    const fixture = ids.parse(JSON.parse(await readFile(fixtureFile, "utf8")));
    for (const [id, state] of [[fixture.quarantined, "quarantined"], [fixture.clean, "clean"], [fixture.malware, "rejected"],
      [fixture.integrity, "rejected"], [fixture.pending, "pending"], [fixture.deleting, "deleting"], [fixture.deleted, "deleted"]]) {
      assert.equal((await catalog.get(alice, id))?.state, state);
      assert.equal(await catalog.get(bob, id), null);
    }
    assert.equal(await objects.get(bob, fixture.clean), null);
    assert.equal(new TextDecoder().decode((await objects.get(alice, fixture.integrity))!), "corrupt retained evidence");
    const tokens = { alice: "backup-alice-".repeat(5), bob: "backup-bob-".repeat(5), metadata: "backup-metadata-".repeat(5) };
    process.env.AUTH_PROVIDER = "api-key";
    process.env.APP_API_KEYS = JSON.stringify(Object.entries(tokens).map(([name, token]) => ({
      ...(name === "bob" ? bob : alice), sha256: createHash("sha256").update(token).digest("hex"),
      scopes: name === "metadata" ? ["uploads:read"] : ["uploads:read", "uploads:write", "uploads:download"],
    })));
    process.env.UPLOAD_DOWNLOAD_POLICY = "scan-on-read";
    let scans = 0;
    const api = uploadHandlers(async () => catalog, async () => objects, async () => ({
      async scan() { scans++; return "clean" as const; }, async ping() {},
    }));
    const request = (id: string, token: string, method = "GET") => new Request(`http://localhost/api/v1/uploads/${id}/download`, {
      method, headers: { authorization: `Bearer ${token}` },
    });
    assert.equal((await api.download(request(fixture.clean, "unknown"), fixture.clean)).status, 401);
    assert.equal((await api.download(request(fixture.clean, tokens.bob), fixture.clean)).status, 404);
    assert.equal((await api.download(request(fixture.clean, tokens.metadata), fixture.clean)).status, 403);
    for (const id of [fixture.malware, fixture.integrity])
      assert.equal((await api.download(request(id, tokens.alice), id)).status, 422);
    assert.equal(scans, 0);
    for (const id of [fixture.quarantined, fixture.clean]) {
      const response = await api.download(request(id, tokens.alice), id);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), payload);
    }
    assert.equal(scans, 2, "Restored clean metadata cannot replace a fresh scan");
    assert.equal((await api.download(request(fixture.pending, tokens.alice), fixture.pending)).status, 409);
    assert.equal((await api.download(request(fixture.deleting, tokens.alice), fixture.deleting)).status, 409);
    assert.equal((await api.download(request(fixture.deleted, tokens.alice), fixture.deleted)).status, 404);
    const before = await catalog.usage(alice);
    assert.equal((await api.delete(request(fixture.clean, tokens.alice, "DELETE"), fixture.clean)).status, 204);
    assert.equal(await objects.get(alice, fixture.clean), null);
    assert.equal((await catalog.get(alice, fixture.clean))?.state, "deleted");
    assert.deepEqual(await catalog.usage(alice), { files: before.files - 1, bytes: before.bytes - payload.length });
    console.log("Restored uploads passed production HTTP ownership/scope, fresh scan, absorbing rejection, lifecycle and quota deletion contracts.");
  }
} finally { await catalog.close(); }
