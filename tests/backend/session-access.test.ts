import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sessionAccessContract } from "../contracts/session-access";

sessionAccessContract("SQLite", async () => sqliteAccessStore(":memory:"));
it("upgrades legacy SQLite ownership without inventing a creation date", async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-legacy-access-")), path = join(directory,"app.sqlite");
  const owner = { tenant: "org",subject: "alice" }, id = randomUUID(), operationId = randomUUID();
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE app_conversations (id TEXT PRIMARY KEY,tenant TEXT NOT NULL,subject TEXT NOT NULL,operation_id TEXT UNIQUE NOT NULL,request_hash TEXT NOT NULL,session_id TEXT UNIQUE,status TEXT NOT NULL)");
    db.prepare("INSERT INTO app_conversations VALUES (?,?,?,?,?,?,?)").run(id,owner.tenant,owner.subject,operationId,"a".repeat(64),"legacy-session","active"); db.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      const store = sqliteAccessStore(path);
      try {
        expect((await store.list(owner,{})).items).toEqual([{ id,operationId,createdAt: 0,title: "New conversation",archived: false,revision: 1,status: "active" }]);
        expect(await store.ownsSession(owner,"legacy-session")).toBe(true);
      } finally { await store.close(); }
    }
  } finally { await rm(directory,{ recursive: true }); }
});
it("retains ownership, revocation and replay receipts after reconnecting", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jumpstart-access-"));
  const path = join(directory, "app.sqlite"), owner = { tenant: "org", subject: "user" };
  const input = { ...owner, id: randomUUID(), operationId: randomUUID(), requestHash: "a".repeat(64) };
  const first = sqliteAccessStore(path), now = Date.now();
  try {
    await first.reserve(input); await first.bind(owner, input.operationId, "session");
    await first.claimNonce("b".repeat(64), now + 10000, now);
    await first.close();
    const second = sqliteAccessStore(path);
    try {
      expect(await second.ownsSession(owner, "session")).toBe(true);
      expect(await second.claimNonce("b".repeat(64), now + 10000, now)).toBe(false);
      await second.revoke(owner, input.id);
    } finally { await second.close(); }
    const third = sqliteAccessStore(path);
    try { expect(await third.ownsSession(owner, "session")).toBe(false); }
    finally { await third.close(); }
  } finally { await rm(directory, { recursive: true }); }
});
