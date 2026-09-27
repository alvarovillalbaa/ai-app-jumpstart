import { reviewOfUpload,uploadReviewDecision } from "./review-contract";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { accessOwner } from "../agent-access/contract";
import { uploadCleanupCandidates, uploadCleanupLimit, withUploadScan, uploadList, uploadQuota, uploadReservation, uploadUsage, uploadScanDecision, staleUploadCutoff, type UploadCatalog } from "./catalog-contract";
import { uploadId } from "./schema";

type Row = { id: string;tenant: string;subject: string;name: string;media_type: string;size: number;sha256: string;created_at: number;state: string };

export function sqliteUploadCatalog(path: string): UploadCatalog {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS app_uploads (
      id TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL,
      name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 5242880),
      sha256 TEXT NOT NULL, created_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','quarantined','clean','rejected','deleting','deleted')));`);
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='app_uploads'").get() as { sql: string };
  if (!schema.sql.includes("'clean'")) {
    // SQLite cannot alter a CHECK constraint. Rebuild only this owned table
    // inside one writer transaction, preserving IDs, quota and tombstones.
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE app_uploads_scan_upgrade (
        id TEXT PRIMARY KEY,tenant TEXT NOT NULL,subject TEXT NOT NULL,name TEXT NOT NULL,media_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 5242880),sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','quarantined','clean','rejected','deleting','deleted')));
        INSERT INTO app_uploads_scan_upgrade SELECT id,tenant,subject,name,media_type,size,sha256,created_at,state FROM app_uploads;
        DROP TABLE app_uploads;
        ALTER TABLE app_uploads_scan_upgrade RENAME TO app_uploads;`);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK");db.close();throw error; }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS app_uploads_owner_state ON app_uploads(tenant,subject,state,created_at,id);
    CREATE INDEX IF NOT EXISTS app_uploads_cleanup ON app_uploads(state,created_at,id);
    CREATE TABLE IF NOT EXISTS app_upload_scans (
      upload_id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('clean','rejected')),
      reason TEXT,checked_at INTEGER NOT NULL,policy_version INTEGER NOT NULL CHECK(policy_version=1));`);
  db.exec(`CREATE TABLE IF NOT EXISTS app_upload_reviews (upload_id TEXT PRIMARY KEY REFERENCES app_uploads(id),
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),approved_sha256 TEXT,approved_at INTEGER,checked_at INTEGER);
    CREATE TRIGGER IF NOT EXISTS upload_review_invalidate AFTER UPDATE OF state ON app_uploads
      WHEN NEW.state IN ('rejected','deleting','deleted') AND NEW.state != OLD.state BEGIN
      UPDATE app_upload_reviews SET revision=MIN(revision+1,2147483647),approved_sha256=NULL,approved_at=NULL,checked_at=NULL WHERE upload_id=NEW.id;
    END;`);
  const reviewById = db.prepare("SELECT revision,approved_sha256 AS approvedSha256,approved_at AS approvedAt,checked_at AS checkedAt FROM app_upload_reviews WHERE upload_id=?");
  type Receipt = { revision: number;approvedSha256: string|null;approvedAt: number|null;checkedAt: number|null };
  const byId = db.prepare("SELECT * FROM app_uploads WHERE id=?");
  const owned = db.prepare("SELECT * FROM app_uploads WHERE tenant=? AND subject=? AND id=?");
  const usage = db.prepare("SELECT COUNT(*) AS files,COALESCE(SUM(size),0) AS bytes FROM app_uploads WHERE tenant=? AND subject=? AND state!='deleted'");
  const scanById = db.prepare("SELECT sha256,status,reason,checked_at AS checkedAt,policy_version AS policyVersion FROM app_upload_scans WHERE upload_id=?");
  function entry(row: Row) {
    const scan = scanById.get(row.id) as { sha256: string;status: string;reason: string | null;checkedAt: number;policyVersion: number } | undefined;
    return withUploadScan({ id: row.id,name: row.name,mediaType: row.media_type,size: row.size,
      sha256: row.sha256,createdAt: row.created_at,state: row.state },scan && { sha256: scan.sha256,status: scan.status,
      checkedAt: scan.checkedAt,policyVersion: scan.policyVersion,...(scan.reason ? { reason: scan.reason } : {}) });
  }
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
    async markStored(owner,id) {
      if (transition(owner,id,["pending"],"quarantined")) return true;
      const checked = accessOwner.parse(owner),row = owned.get(checked.tenant,checked.subject,uploadId.parse(id)) as Row | undefined;
      return row?.state === "clean" || row?.state === "rejected";
    },
    async recordScan(owner,rawId,rawDecision) {
      const checked = accessOwner.parse(owner),id = uploadId.parse(rawId),decision = uploadScanDecision.parse(rawDecision);
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = owned.get(checked.tenant,checked.subject,id) as Row | undefined;
        const old = scanById.get(id) as { status: string;checkedAt: number } | undefined;
        if (!row || !["quarantined","clean"].includes(row.state) || row.sha256 !== decision.sha256 || old?.status === "rejected" ||
            decision.status === "clean" && old && old.checkedAt > decision.checkedAt) { db.exec("COMMIT");return false; }
        db.prepare(`INSERT INTO app_upload_scans(upload_id,sha256,status,reason,checked_at,policy_version) VALUES(?,?,?,?,?,?)
          ON CONFLICT(upload_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,checked_at=excluded.checked_at,policy_version=excluded.policy_version`)
          .run(id,decision.sha256,decision.status,decision.status === "rejected" ? decision.reason : null,decision.checkedAt,decision.policyVersion);
        db.prepare("UPDATE app_uploads SET state=? WHERE id=?").run(decision.status,id);
        db.exec("COMMIT");return true;
      } catch (error) { db.exec("ROLLBACK");throw error; }
    },
    async getReview(owner,rawId) {
      const checked = accessOwner.parse(owner),id = uploadId.parse(rawId),row = owned.get(checked.tenant,checked.subject,id) as Row | undefined;
      return row && row.state !== "deleted" ? reviewOfUpload(row,reviewById.get(id) as Receipt | undefined) : null;
    },
    async recordReview(owner,rawId,rawDecision) {
      const checked = accessOwner.parse(owner),id = uploadId.parse(rawId),decision = uploadReviewDecision.parse(rawDecision);
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = owned.get(checked.tenant,checked.subject,id) as Row | undefined;
        const receipt = reviewById.get(id) as Receipt | undefined;
        let result;
        if (!row || row.state === "deleted") result = { status: "unavailable" as const };
        else if (row.sha256 !== decision.sha256 || (receipt?.revision ?? 0) !== decision.revision) result = { status: "conflict" as const };
        else {
          const scan = scanById.get(id) as { status: string;sha256: string;checkedAt: number } | undefined;
          if (decision.approved && (row.state !== "clean" || scan?.status !== "clean" || scan.sha256 !== row.sha256 || scan.checkedAt !== decision.checkedAt)) result = { status: "busy" as const };
          else {
            db.prepare(`INSERT INTO app_upload_reviews VALUES(?,?,?,?,?) ON CONFLICT(upload_id) DO UPDATE SET
              revision=excluded.revision,approved_sha256=excluded.approved_sha256,approved_at=excluded.approved_at,checked_at=excluded.checked_at`)
              .run(id,decision.revision+1,decision.approved ? row.sha256 : null,decision.approved ? decision.at : null,decision.approved ? decision.checkedAt! : null);
            result = { status: "updated" as const,review: reviewOfUpload(row,reviewById.get(id) as Receipt) };
          }
        }
        db.exec("COMMIT");return result;
      } catch (error) { db.exec("ROLLBACK");throw error; }
    },
    async get(owner,rawId) {
      const checked = accessOwner.parse(owner),row = owned.get(checked.tenant,checked.subject,uploadId.parse(rawId)) as Row | undefined;
      return row ? entry(row) : null;
    },
    async list(owner) {
      const checked = accessOwner.parse(owner);
      const rows = db.prepare("SELECT * FROM app_uploads WHERE tenant=? AND subject=? AND state!='deleted' ORDER BY created_at DESC,id DESC LIMIT 1001")
        .all(checked.tenant,checked.subject) as Row[];
      return uploadList.parse(rows.map(entry));
    },
    async beginDelete(owner,id) { return transition(owner,id,["pending","quarantined","clean","rejected"],"deleting"); },
    async claimStalePending(owner,rawId,rawCutoff) {
      const checked = accessOwner.parse(owner),id = uploadId.parse(rawId),cutoff = staleUploadCutoff.parse(rawCutoff);
      return db.prepare("UPDATE app_uploads SET state='deleting' WHERE tenant=? AND subject=? AND id=? AND state='pending' AND created_at<=?")
        .run(checked.tenant,checked.subject,id,cutoff).changes === 1;
    },
    async listCleanupCandidates(rawCutoff,rawLimit) {
      const cutoff = staleUploadCutoff.parse(rawCutoff),limit = uploadCleanupLimit.parse(rawLimit);
      const rows = db.prepare("SELECT tenant,subject,id,state,created_at AS createdAt FROM app_uploads WHERE state IN ('pending','deleting') AND created_at<=? ORDER BY created_at,id LIMIT ?")
        .all(cutoff,limit);
      return uploadCleanupCandidates.parse(rows);
    },
    async finishDelete(owner,id) { return transition(owner,id,["deleting"],"deleted"); },
    async usage(owner) { const checked = accessOwner.parse(owner);return uploadUsage.parse(usage.get(checked.tenant,checked.subject)); },
    async close() { db.close(); },
  };
}
