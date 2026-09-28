import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SqlSessionAccessStore } from "./sql-store";
import { cacheFromFacts,materializeRun,runFact } from "./run-contract";
import { projectionEntry } from "./projection-contract";
import { installSqliteAccountFences } from "../account-closure/sqlite-fences";

export function sqliteAccessStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.function("app_materialize_run",(existing,entry,ordinal,source) => materializeRun(existing === null ? null : String(existing),projectionEntry.parse(JSON.parse(String(entry))),Number(ordinal),source === null ? null : Number(source)));
  db.function("app_backfill_run",rows => {
    const facts = Object.fromEntries(JSON.parse(String(rows)).map((row: { entry: string;ordinal: number;sourceIndex: number|null }) => {
      const entry = projectionEntry.parse(JSON.parse(row.entry));
      return [entry.eventId,runFact(entry,row.ordinal,row.sourceIndex)];
    }));
    return cacheFromFacts(facts);
  });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS app_conversations (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
      session_id TEXT UNIQUE, status TEXT NOT NULL CHECK(status IN ('starting','active','revoked')),
      projection_checkpoint INTEGER NOT NULL DEFAULT 0 CHECK(projection_checkpoint >= 0 AND projection_checkpoint <= 9007199254740991),
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
    CREATE TABLE IF NOT EXISTS app_conversation_events (ordinal INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL REFERENCES app_conversations(operation_id),event_id TEXT NOT NULL,payload TEXT NOT NULL,source_index INTEGER CHECK(source_index >= 0),UNIQUE(operation_id,event_id),UNIQUE(operation_id,source_index));`);
  // Additive upgrade for existing local databases, serialized across processes.
  db.exec("BEGIN IMMEDIATE");
  try {
    const hasRuns = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='app_conversation_runs'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS app_conversation_runs (operation_id TEXT NOT NULL REFERENCES app_conversations(operation_id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL,first_ordinal INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(operation_id,turn_id));
      CREATE INDEX IF NOT EXISTS conversation_runs_page ON app_conversation_runs(operation_id,first_ordinal);`);
    const columns = new Set(db.prepare("PRAGMA table_info(app_conversations)").all().map(row => row.name));
    for (const [name,definition] of Object.entries({ title: "TEXT NOT NULL DEFAULT 'New conversation'", created_at: "INTEGER NOT NULL DEFAULT 0", archived: "INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1))", revision: "INTEGER NOT NULL DEFAULT 1",projection_checkpoint: "INTEGER NOT NULL DEFAULT 0 CHECK(projection_checkpoint >= 0 AND projection_checkpoint <= 9007199254740991)" })) {
      if (!columns.has(name)) db.exec(`ALTER TABLE app_conversations ADD COLUMN ${name} ${definition}`);
    }
    const artifactColumns = new Set(db.prepare("PRAGMA table_info(app_artifacts)").all().map(row => row.name));
    if (!artifactColumns.has("deleted_at")) db.exec("ALTER TABLE app_artifacts ADD COLUMN deleted_at INTEGER");
    if (!artifactColumns.has("revision")) db.exec("ALTER TABLE app_artifacts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision BETWEEN 1 AND 100)");
    if (!artifactColumns.has("updated_at")) db.exec("ALTER TABLE app_artifacts ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0");
    db.exec(`UPDATE app_artifacts SET updated_at=created_at WHERE updated_at=0;
      CREATE TABLE IF NOT EXISTS app_artifact_versions (artifact_id TEXT NOT NULL REFERENCES app_artifacts(id),
        revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 100),title TEXT NOT NULL,content TEXT NOT NULL,updated_at INTEGER NOT NULL,
        PRIMARY KEY(artifact_id,revision));
      INSERT INTO app_artifact_versions(artifact_id,revision,title,content,updated_at)
        SELECT id,revision,title,content,updated_at FROM app_artifacts WHERE deleted_at IS NULL ON CONFLICT DO NOTHING;
      CREATE TRIGGER IF NOT EXISTS artifact_version_guard BEFORE UPDATE OF title,content,revision,input_hash,deleted_at ON app_artifacts
        WHEN OLD.deleted_at IS NOT NULL OR (NEW.deleted_at IS NULL AND (NEW.revision != OLD.revision+1 OR NEW.input_hash != OLD.input_hash)) BEGIN
        SELECT RAISE(ABORT,'Artifact edits require a new revision');
      END;
      CREATE TRIGGER IF NOT EXISTS artifact_version_insert AFTER INSERT ON app_artifacts WHEN NEW.deleted_at IS NULL BEGIN
        INSERT INTO app_artifact_versions VALUES(NEW.id,NEW.revision,NEW.title,NEW.content,NEW.created_at);
      END;
      CREATE TRIGGER IF NOT EXISTS artifact_version_update AFTER UPDATE OF revision ON app_artifacts
        WHEN NEW.deleted_at IS NULL AND NEW.revision != OLD.revision BEGIN
        INSERT INTO app_artifact_versions VALUES(NEW.id,NEW.revision,NEW.title,NEW.content,NEW.updated_at);
      END;
      CREATE TRIGGER IF NOT EXISTS artifact_version_erase AFTER UPDATE OF deleted_at ON app_artifacts WHEN NEW.deleted_at IS NOT NULL BEGIN
        DELETE FROM app_artifact_versions WHERE artifact_id=NEW.id;
      END;`);
    const eventColumns = new Set(db.prepare("PRAGMA table_info(app_conversation_events)").all().map(row => row.name));
    if (!eventColumns.has("source_index")) db.exec("ALTER TABLE app_conversation_events ADD COLUMN source_index INTEGER CHECK(source_index >= 0)");
    db.exec(`CREATE TRIGGER IF NOT EXISTS conversation_runs_insert AFTER INSERT ON app_conversation_events
      WHEN json_extract(NEW.payload,'$.payload.kind') IN ('run','model') BEGIN
        INSERT INTO app_conversation_runs(operation_id,turn_id,first_ordinal,payload)
        VALUES(NEW.operation_id,json_extract(NEW.payload,'$.turnId'),NEW.ordinal,app_materialize_run(NULL,NEW.payload,NEW.ordinal,NEW.source_index))
        ON CONFLICT(operation_id,turn_id) DO UPDATE SET first_ordinal=MIN(first_ordinal,excluded.first_ordinal),
          payload=app_materialize_run(payload,NEW.payload,NEW.ordinal,NEW.source_index);
      END;
      CREATE TRIGGER IF NOT EXISTS conversation_runs_source AFTER UPDATE OF source_index ON app_conversation_events
      WHEN json_extract(NEW.payload,'$.payload.kind') IN ('run','model') BEGIN
        INSERT INTO app_conversation_runs(operation_id,turn_id,first_ordinal,payload)
        VALUES(NEW.operation_id,json_extract(NEW.payload,'$.turnId'),NEW.ordinal,app_materialize_run(NULL,NEW.payload,NEW.ordinal,NEW.source_index))
        ON CONFLICT(operation_id,turn_id) DO UPDATE SET first_ordinal=MIN(first_ordinal,excluded.first_ordinal),
          payload=app_materialize_run(payload,NEW.payload,NEW.ordinal,NEW.source_index);
      END;`);
    if (!hasRuns) db.exec(`INSERT INTO app_conversation_runs(operation_id,turn_id,first_ordinal,payload)
      SELECT operation_id,json_extract(payload,'$.turnId'),MIN(ordinal),app_backfill_run(json_group_array(json_object('entry',payload,'ordinal',ordinal,'sourceIndex',source_index)))
      FROM app_conversation_events WHERE json_extract(payload,'$.payload.kind') IN ('run','model') GROUP BY operation_id,json_extract(payload,'$.turnId')`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS conversation_events_source ON app_conversation_events(operation_id,source_index)");
    db.exec("CREATE INDEX IF NOT EXISTS conversations_history ON app_conversations(tenant,subject,archived,created_at DESC,id DESC); COMMIT");
  } catch (error) { db.exec("ROLLBACK"); db.close(); throw error; }
  installSqliteAccountFences(db,["app_conversations","app_conversation_events","app_conversation_runs","app_artifacts","app_artifact_versions"]);
  return new SqlSessionAccessStore({ query: async (sql, parameters) => db.prepare(sql).all(...parameters), close: async () => db.close() });
}
