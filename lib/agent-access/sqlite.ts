import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqlSessionAccessStore } from "./sql-store";

export function sqliteAccessStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS app_conversations (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      session_id TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('starting','active','revoked')),
      CHECK(status != 'active' OR session_id IS NOT NULL));
    CREATE INDEX IF NOT EXISTS conversations_owner ON app_conversations(tenant, subject, operation_id);
    CREATE TABLE IF NOT EXISTS app_internal_nonces (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS nonces_expiry ON app_internal_nonces(expires_at);
    CREATE TABLE IF NOT EXISTS app_artifacts (
      id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES app_conversations(operation_id),
      session_id TEXT NOT NULL,call_id TEXT NOT NULL,input_hash TEXT NOT NULL,
      title TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL,deleted_at INTEGER,
      UNIQUE(operation_id,call_id));
    CREATE INDEX IF NOT EXISTS artifacts_owner_time ON app_artifacts(operation_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS app_conversation_events (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL REFERENCES app_conversations(operation_id),event_id TEXT NOT NULL,payload TEXT NOT NULL,UNIQUE(operation_id,event_id));`);
  // Additive upgrade for existing local databases, serialized across processes.
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = new Set(db.prepare("PRAGMA table_info(app_conversations)").all().map(row => row.name));
    for (const [name,definition] of Object.entries({ title: "TEXT NOT NULL DEFAULT 'New conversation'", created_at: "INTEGER NOT NULL DEFAULT 0", archived: "INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))", revision: "INTEGER NOT NULL DEFAULT 1" })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE app_conversations ADD COLUMN ${name} ${definition}`);
    }
    const artifactColumns = new Set(db.prepare("PRAGMA table_info(app_artifacts)").all().map(row => row.name));
    if (!artifactColumns.has("deleted_at")) db.exec("ALTER TABLE app_artifacts ADD COLUMN deleted_at INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS conversations_history ON app_conversations(tenant,subject,archived,created_at DESC,id DESC); COMMIT");
  } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
  return new SqlSessionAccessStore({ query: async (sql, parameters) => db.prepare(sql).all(...parameters), close: async () => db.close() });
}
