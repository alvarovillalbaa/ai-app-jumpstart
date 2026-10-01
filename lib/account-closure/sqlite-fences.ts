import type { DatabaseSync } from "node:sqlite";

/** SQLite serializes writers, so an inserted fence orders after earlier writes
 * and before every later INSERT/UPDATE trigger on the same database file. */
const ownerPaths = {
  app_records: null,
  app_record_creates: null,
  app_conversations: null,
  app_conversation_events: ["app_conversations c","c.operation_id","operation_id","c.tenant","c.subject"],
  app_conversation_runs: ["app_conversations c","c.operation_id","operation_id","c.tenant","c.subject"],
  app_artifacts: ["app_conversations c","c.operation_id","operation_id","c.tenant","c.subject"],
  app_artifact_versions: ["app_artifacts a JOIN app_conversations c ON c.operation_id=a.operation_id","a.id","artifact_id","c.tenant","c.subject"],
  app_budget_reservations: null,
  app_budget_attempts: ["app_budget_reservations r","r.operation_id","operation_id","r.tenant","r.subject"],
  app_budget_corrections: null,
  app_uploads: null,
  app_upload_scans: ["app_uploads u","u.id","upload_id","u.tenant","u.subject"],
  app_upload_reviews: ["app_uploads u","u.id","upload_id","u.tenant","u.subject"],
  app_user_preferences: null,
  app_request_limits: null,
} as const;

export const sqliteFencedTables = Object.freeze(Object.keys(ownerPaths));
export type SqliteFencedTable = keyof typeof ownerPaths;

export function installSqliteAccountFences(db: DatabaseSync,tables: readonly SqliteFencedTable[]) {
  db.exec(`CREATE TABLE IF NOT EXISTS app_account_fences (
    tenant TEXT NOT NULL CHECK(length(tenant) BETWEEN 1 AND 200),
    subject TEXT NOT NULL CHECK(length(subject) BETWEEN 1 AND 200),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(tenant,subject));
    CREATE TRIGGER IF NOT EXISTS app_account_fences_no_update BEFORE UPDATE ON app_account_fences
      BEGIN SELECT RAISE(ABORT,'Account write fences are permanent'); END;
    CREATE TRIGGER IF NOT EXISTS app_account_fences_no_delete BEFORE DELETE ON app_account_fences
      BEGIN SELECT RAISE(ABORT,'Account write fences are permanent'); END;`);
  for (const table of tables) {
    const path: readonly string[] | null = ownerPaths[table];
    if (path === null) {
      const check = `SELECT RAISE(ABORT,'Account application writes are fenced') WHERE EXISTS
        (SELECT 1 FROM app_account_fences f WHERE f.tenant=NEW.tenant AND f.subject=NEW.subject);`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_account_fence_insert BEFORE INSERT ON ${table}
        BEGIN ${check} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_account_fence_update BEFORE UPDATE ON ${table}
        BEGIN
          SELECT RAISE(ABORT,'Account row owner cannot change')
            WHERE OLD.tenant IS NOT NEW.tenant OR OLD.subject IS NOT NEW.subject;
          ${check}
        END;`);
    } else {
      const [from,parentKey,childKey,tenant,subject] = path;
      const check = `SELECT RAISE(ABORT,'Account child has no attributable owner') WHERE NOT EXISTS
        (SELECT 1 FROM ${from} WHERE ${parentKey}=NEW.${childKey});
        SELECT RAISE(ABORT,'Account application writes are fenced') WHERE EXISTS
        (SELECT 1 FROM ${from} JOIN app_account_fences f ON f.tenant=${tenant} AND f.subject=${subject}
          WHERE ${parentKey}=NEW.${childKey});`;
      db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_account_fence_insert BEFORE INSERT ON ${table}
        BEGIN ${check} END;
        CREATE TRIGGER IF NOT EXISTS ${table}_account_fence_update BEFORE UPDATE ON ${table}
        BEGIN
          SELECT RAISE(ABORT,'Account child owner key cannot change') WHERE OLD.${childKey} IS NOT NEW.${childKey};
          ${check}
        END;`);
    }
  }
}
