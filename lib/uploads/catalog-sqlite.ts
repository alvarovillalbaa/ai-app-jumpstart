import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { accessOwner } from "../agent-access/contract";
import { uploadEntry, uploadQuota, uploadReservation, uploadUsage, type UploadCatalog } from "./catalog-contract";
import { uploadId } from "./schema";

type Row = { id: string;tenant: string;subject: string;name: string;media_type: string;size: number;sha256: string;created_at: number;state: string };
const entry = (row: Row) => uploadEntry.parse({ id: row.id,name: row.name,mediaType: row.media_type,size: row.size,
  sha256: row.sha256,createdAt: row.created_at,state: row.state });

export function sqliteUploadCatalog(path: string): UploadCatalog {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS app_uploads (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL,
      name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 5242880),
      sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','quarantined','deleting','deleted')));
    CREATE INDEX IF NOT EXISTS app_uploads_owner_state ON app_uploads(tenant,subject,state,created_at,id);`);
  const byId = db.prepare("SELECT * FROM app_uploads WHERE id=?");
  const owned = db.prepare("SELECT * FROM app_uploads WHERE tenant=? AND subject=? AND id=?");
  const usage = db.prepare("SELECT COUNT(*) AS files,COALESCE(SUM(size),0) AS bytes FROM app_uploads WHERE tenant=? AND subject=? AND state!='deleted'");
  function transition(owner: Parameters<UploadCatalog["get"]>[0], rawId: string, from: string[], to: string) {
    const checked = accessOwner.parse(owner),id = uploadId.parse(rawId);
    const placeholders = from.map(() => "?").join(",");
    db.prepare(`UPDATE app_uploads SET state=? WHERE tenant=? AND subject=? AND id=? AND state IN (${placeholders})`)
      .run(to,checked.tenant,checked.subject,id,...from);
    return (owned.get(checked.tenant,checked.subject,id) as Row | undefined)?.state === to;
  }
  return {
    async reserve(owner, rawInput, rawQuota) {
      const checked = accessOwner.parse(owner),input = uploadReservation.parse(rawInput),quota = uploadQuota.parse(rawQuota);
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = byId.get(input.id) as Row | undefined;
        if (existing) {
          const same = existing.tenant === checked.tenant && existing.subject === checked.subject &&
            existing.name === input.name && existing.media_type === input.mediaType && existing.size === input.size && existing.sha256 === input.sha256;
          db.exec("COMMIT");
          return same ? "existing" : "conflict";
        }
        const current = uploadUsage.parse(usage.get(checked.tenant,checked.subject));
        if (current.files >= quota.maxFiles || current.bytes + input.size > quota.maxBytes) {
          db.exec("COMMIT");return "quota";
        }
        db.prepare(`INSERT INTO app_uploads(id,tenant,subject,name,media_type,size,sha256,created_at,state)
          VALUES(?,?,?,?,?,?,?,?, 'pending')`).run(input.id,checked.tenant,checked.subject,input.name,input.mediaType,input.size,input.sha256,input.createdAt);
        db.exec("COMMIT");return "reserved";
      } catch (error) { db.exec("ROLLBACK");throw error; }
    },
    async markStored(owner,id) { return transition(owner,id,["pending"],"quarantined"); },
    async get(owner,rawId) {
      const checked = accessOwner.parse(owner),row = owned.get(checked.tenant,checked.subject,uploadId.parse(rawId)) as Row | undefined;
      return row ? entry(row) : null;
    },
    async beginDelete(owner,id) { return transition(owner,id,["pending","quarantined"],"deleting"); },
    async finishDelete(owner,id) { return transition(owner,id,["deleting"],"deleted"); },
    async usage(owner) { const checked = accessOwner.parse(owner);return uploadUsage.parse(usage.get(checked.tenant,checked.subject)); },
    async close() { db.close(); },
  };
}
