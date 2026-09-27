import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { sqlPreferenceStore } from "./sql";

export function sqlitePreferenceStore(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path),{ recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS app_user_preferences(tenant TEXT NOT NULL,subject TEXT NOT NULL,
      theme TEXT NOT NULL CHECK(theme IN ('system','light','dark')),sound_enabled INTEGER NOT NULL CHECK(sound_enabled IN (0,1)),
      sound_volume REAL NOT NULL CHECK(sound_volume BETWEEN 0 AND 1),revision INTEGER NOT NULL CHECK(revision>0),updated_at TEXT NOT NULL,
      PRIMARY KEY(tenant,subject));`);
  return sqlPreferenceStore({ query: async (sql,params) => db.prepare(sql).all(...params),close: async () => db.close() });
}
