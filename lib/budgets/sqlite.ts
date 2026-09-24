import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { admission, settlement, settlementCorrection, correctionEntry, budgetInspection, lookup, snapshot, dayOf, refusal, attempt, attemptOwner, reservationState, outstandingOptions, outstandingEntry, pageOfOutstanding, ledgerOptions, ledgerEntry, pageOfLedger, type Admission, type Settlement, type BudgetStore, type AdmissionResult } from "./contract";

export function sqliteBudgetStore(path: string): BudgetStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS app_budget_reservations (
      operation_id TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL, request_hash TEXT NOT NULL,
      policy_id TEXT NOT NULL, estimate_micros INTEGER NOT NULL CHECK(estimate_micros>0),
      day INTEGER NOT NULL, created_at INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('reserved','settled')), actual_micros INTEGER CHECK(actual_micros>=0));
    CREATE INDEX IF NOT EXISTS budget_owner_day ON app_budget_reservations(tenant,subject,day);
    CREATE INDEX IF NOT EXISTS budget_owner_time ON app_budget_reservations(tenant,subject,created_at);
    CREATE INDEX IF NOT EXISTS budget_owner_ledger ON app_budget_reservations(tenant,subject,created_at,operation_id);
    CREATE INDEX IF NOT EXISTS budget_owner_status ON app_budget_reservations(tenant,subject,status);
    CREATE INDEX IF NOT EXISTS budget_outstanding_time ON app_budget_reservations(status,created_at,operation_id);
    CREATE TABLE IF NOT EXISTS app_budget_attempts (operation_id TEXT NOT NULL, attempt_id TEXT NOT NULL, PRIMARY KEY(operation_id,attempt_id));
    CREATE TABLE IF NOT EXISTS app_budget_corrections (
      correction_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES app_budget_reservations(operation_id),
      tenant TEXT NOT NULL, subject TEXT NOT NULL, previous_actual_micros INTEGER, corrected_actual_micros INTEGER NOT NULL,
      actor TEXT NOT NULL, reason TEXT NOT NULL, evidence_ref TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS budget_corrections_operation ON app_budget_corrections(operation_id,at,correction_id);
    CREATE TRIGGER IF NOT EXISTS budget_corrections_no_update BEFORE UPDATE ON app_budget_corrections
      BEGIN SELECT RAISE(ABORT,'Budget correction audit entries are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS budget_corrections_no_delete BEFORE DELETE ON app_budget_corrections
      BEGIN SELECT RAISE(ABORT,'Budget correction audit entries are immutable'); END;`);
  function read(input: ReturnType<typeof lookup.parse>) {
    const day = dayOf(input.now);
    const row = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN day=? AND status='reserved' THEN estimate_micros ELSE 0 END),0) AS reservedMicros,
      COALESCE(SUM(CASE WHEN day=? AND status='settled' THEN COALESCE(actual_micros,estimate_micros) ELSE 0 END),0) AS chargedMicros,
      COUNT(CASE WHEN status='reserved' THEN 1 END) AS active,
      COUNT(CASE WHEN created_at>? THEN 1 END) AS recent,
      COUNT(CASE WHEN day=? AND status='settled' AND actual_micros IS NULL THEN 1 END) AS unknownCosts
      FROM app_budget_reservations WHERE tenant=? AND subject=? AND (day=? OR status='reserved' OR created_at>?)`).get(day, day, input.now - 60000, day, input.tenant, input.subject, day, input.now - 60000);
    return snapshot.parse({ ...row, day });
  }
  // No async work occurs inside this transaction. BEGIN IMMEDIATE serializes
  // independent processes as well as calls through this object.
  function transaction<T>(fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return {
    async reserve(raw: Admission): Promise<AdmissionResult> {
      const input = admission.parse(raw);
      return transaction(() => {
        const existing = db.prepare("SELECT * FROM app_budget_reservations WHERE operation_id=?").get(input.operationId);
        if (existing) {
          if (existing.tenant !== input.tenant || existing.subject !== input.subject || existing.request_hash !== input.requestHash || existing.estimate_micros !== input.estimateMicros || existing.policy_id !== input.policy.id) return { status: "denied", reason: "conflict" };
          return { status: existing.status === "settled" ? "settled" : "reserved", created: false };
        }
        const denied = refusal(read(input), input); if (denied) return denied;
        db.prepare("INSERT INTO app_budget_reservations(operation_id,tenant,subject,request_hash,policy_id,estimate_micros,day,created_at,status) VALUES (?,?,?,?,?,?,?,?,'reserved')").run(input.operationId,input.tenant,input.subject,input.requestHash,input.policy.id,input.estimateMicros,dayOf(input.now),input.now);
        return { status: "reserved", created: true };
      });
    },
    async settle(raw: Settlement) {
      const input = settlement.parse(raw);
      return transaction(() => {
        const row = db.prepare("SELECT status,actual_micros FROM app_budget_reservations WHERE operation_id=? AND tenant=? AND subject=?").get(input.operationId,input.tenant,input.subject);
        if (!row) return false;
        if (row.status === "settled") return row.actual_micros === input.actualMicros;
        db.prepare("UPDATE app_budget_reservations SET status='settled',actual_micros=? WHERE operation_id=?").run(input.actualMicros,input.operationId);
        return true;
      });
    },
    async correctSettlement(raw) {
      const input = settlementCorrection.parse(raw);
      return transaction(() => {
        const existing = db.prepare("SELECT * FROM app_budget_corrections WHERE correction_id=?").get(input.correctionId);
        if (existing) return existing.operation_id === input.operationId && existing.tenant === input.tenant && existing.subject === input.subject &&
          existing.previous_actual_micros === input.expectedActualMicros && existing.corrected_actual_micros === input.correctedActualMicros &&
          existing.actor === input.actor && existing.reason === input.reason && existing.evidence_ref === input.evidenceRef
          ? "already_applied" : "conflict";
        const row = db.prepare("SELECT status,actual_micros FROM app_budget_reservations WHERE operation_id=? AND tenant=? AND subject=?")
          .get(input.operationId,input.tenant,input.subject);
        if (!row) return "not_found";
        if (row.status !== "settled" || row.actual_micros !== input.expectedActualMicros || row.actual_micros === input.correctedActualMicros) return "conflict";
        db.prepare("UPDATE app_budget_reservations SET actual_micros=? WHERE operation_id=?").run(input.correctedActualMicros,input.operationId);
        db.prepare(`INSERT INTO app_budget_corrections(correction_id,operation_id,tenant,subject,previous_actual_micros,corrected_actual_micros,actor,reason,evidence_ref,at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(input.correctionId,input.operationId,input.tenant,input.subject,input.expectedActualMicros,
            input.correctedActualMicros,input.actor,input.reason,input.evidenceRef,Date.now());
        return "applied";
      });
    },
    async listCorrections(raw) {
      const input = attemptOwner.parse(raw);
      return db.prepare(`SELECT correction_id AS correctionId,operation_id AS operationId,tenant,subject,
        previous_actual_micros AS previousActualMicros,corrected_actual_micros AS correctedActualMicros,actor,reason,evidence_ref AS evidenceRef,at
        FROM app_budget_corrections WHERE operation_id=? AND tenant=? AND subject=? ORDER BY at DESC,correction_id DESC LIMIT 100`)
        .all(input.operationId,input.tenant,input.subject).map(row => correctionEntry.parse(row));
    },
    async getReservation(raw) {
      const input = attemptOwner.parse(raw);
      const row = db.prepare("SELECT request_hash AS requestHash,status FROM app_budget_reservations WHERE operation_id=? AND tenant=? AND subject=?").get(input.operationId,input.tenant,input.subject);
      return row ? reservationState.parse(row) : null;
    },
    async inspectReservation(raw) {
      const input = attemptOwner.parse(raw);
      const row = db.prepare(`SELECT status,estimate_micros AS estimateMicros,actual_micros AS actualMicros,day,policy_id AS policyId
        FROM app_budget_reservations WHERE operation_id=? AND tenant=? AND subject=?`).get(input.operationId,input.tenant,input.subject);
      return row ? budgetInspection.parse(row) : null;
    },
    async listOutstanding(raw) {
      const input = outstandingOptions.parse(raw);
      const [time,id] = input.cursor?.split(".") ?? [];
      const rows = db.prepare(`SELECT tenant,subject,operation_id AS operationId,created_at AS createdAt,
        estimate_micros AS estimateMicros,policy_id AS policyId FROM app_budget_reservations
        WHERE status='reserved' AND (? IS NULL OR created_at>? OR (created_at=? AND operation_id>?))
        ORDER BY created_at ASC,operation_id ASC LIMIT ?`).all(time ?? null,Number(time ?? 0),Number(time ?? 0),id ?? "",input.limit+1);
      return pageOfOutstanding(rows.map(row => outstandingEntry.parse(row)),input.limit);
    },
    async listLedger(raw) {
      const input = ledgerOptions.parse(raw);
      const [time,id] = input.cursor?.split(".") ?? [];
      const rows = db.prepare(`SELECT operation_id AS operationId,created_at AS createdAt,day,policy_id AS policyId,
        estimate_micros AS estimateMicros,status,actual_micros AS actualMicros FROM app_budget_reservations
        WHERE tenant=? AND subject=? AND (? IS NULL OR created_at>? OR (created_at=? AND operation_id>?))
        ORDER BY created_at ASC,operation_id ASC LIMIT ?`).all(input.tenant,input.subject,time ?? null,Number(time ?? 0),Number(time ?? 0),id ?? "",input.limit+1);
      return pageOfLedger(rows.map(row => ledgerEntry.parse(row)),input.limit);
    },
    async snapshot(raw) { return read(lookup.parse(raw)); },
    async claimAttempt(raw) {
      const input = attempt.parse(raw);
      return transaction(() => {
        const row = db.prepare("SELECT status FROM app_budget_reservations WHERE operation_id=? AND tenant=? AND subject=?").get(input.operationId,input.tenant,input.subject);
        if (row?.status !== "reserved") return false;
        if (db.prepare("SELECT 1 FROM app_budget_attempts WHERE operation_id=? AND attempt_id=?").get(input.operationId,input.attemptId)) return true;
        const count = Number(db.prepare("SELECT COUNT(*) AS n FROM app_budget_attempts WHERE operation_id=?").get(input.operationId)?.n);
        if (count >= input.maxAttempts) return false;
        db.prepare("INSERT INTO app_budget_attempts(operation_id,attempt_id) VALUES (?,?)").run(input.operationId,input.attemptId);
        return true;
      });
    },
    async attemptCount(raw) {
      const input = attemptOwner.parse(raw);
      return Number(db.prepare("SELECT COUNT(*) AS n FROM app_budget_attempts a JOIN app_budget_reservations r ON r.operation_id=a.operation_id WHERE r.operation_id=? AND r.tenant=? AND r.subject=?").get(input.operationId,input.tenant,input.subject)?.n);
    },
    async close() { db.close(); },
  };
}
