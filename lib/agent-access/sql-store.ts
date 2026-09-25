import { accessOwner, reservation, operationId, sessionId, bodyHash, fromAccessRow, type AccessOwner, type Reservation, type SessionAccessStore } from "./contract";
import { conversationTitle, historyOptions, historyPatch, pageOfHistory, summaryFromRow, type HistoryOptions, type HistoryPatch } from "./contract";
import { projectionEntry, projectionOptions, projectionSourceIndex, pageOfProjections, type ProjectionEntry, type ProjectionOptions } from "./projection-contract";
import { artifactInput, artifactCallId, artifactOptions, artifactFromRow, pageOfArtifacts, type ArtifactInput, type ArtifactOptions } from "./artifact-contract";
import { createHash, randomUUID } from "node:crypto";

export interface AccessDatabase {
  lockBinding?: boolean;
  query(sql: string, parameters: (string | number | null)[]): Promise<unknown[]>;
  close(): Promise<void>;
}
export class SqlSessionAccessStore implements SessionAccessStore {
  constructor(private db: AccessDatabase) {}
  async saveArtifact(owner: AccessOwner,operation: string,session: string,callId: string,input: ArtifactInput) {
    const o = accessOwner.parse(owner),id = operationId.parse(operation),sid = sessionId.parse(session),call = artifactCallId.parse(callId),data = artifactInput.parse(input);
    const hash = createHash("sha256").update(JSON.stringify(data)).digest("hex"),createdAt = Date.now();
    const inserted = await this.db.query(`INSERT INTO app_artifacts(id,operation_id,session_id,call_id,input_hash,title,content,created_at)
      SELECT ?,operation_id,?,?,?,?,?,? FROM app_conversations WHERE tenant=? AND subject=? AND operation_id=? AND session_id=? AND status='active'
      ${this.db.lockBinding ? "FOR UPDATE" : ""} ON CONFLICT DO NOTHING RETURNING *`,
      [randomUUID(),sid,call,hash,data.title,data.content,createdAt,o.tenant,o.subject,id,sid]);
    if (inserted[0]) return { status: "created" as const,artifact: artifactFromRow(inserted[0]) };
    const existing = await this.db.query(`SELECT a.* FROM app_artifacts a JOIN app_conversations c ON c.operation_id=a.operation_id
      WHERE c.tenant=? AND c.subject=? AND c.operation_id=? AND c.session_id=? AND c.status='active' AND a.call_id=?`,[o.tenant,o.subject,id,sid,call]);
    if (!existing[0]) return { status: "unavailable" as const };
    const row = existing[0] as { input_hash: string;deleted_at: number | null };
    if (row.deleted_at !== null) return { status: "unavailable" as const };
    return row.input_hash === hash ? { status: "existing" as const,artifact: artifactFromRow(row) } : { status: "conflict" as const };
  }
  async listArtifacts(owner: AccessOwner,options: ArtifactOptions) {
    const o = accessOwner.parse(owner),q = artifactOptions.parse(options),values: (string|number)[] = [o.tenant,o.subject];
    let after = "";
    if (q.cursor) { const [time,id] = q.cursor.split(".");after = " AND (a.created_at < ? OR (a.created_at=? AND a.id<?))";values.push(Number(time),Number(time),id); }
    values.push(q.limit+1);
    const rows = await this.db.query(`SELECT a.* FROM app_artifacts a JOIN app_conversations c ON c.operation_id=a.operation_id
      WHERE c.tenant=? AND c.subject=? AND a.deleted_at IS NULL${after} ORDER BY a.created_at DESC,a.id DESC LIMIT ?`,values);
    return pageOfArtifacts(rows.map(artifactFromRow),q.limit);
  }
  async getArtifact(owner: AccessOwner,id: string) {
    const o = accessOwner.parse(owner);
    const rows = await this.db.query(`SELECT a.* FROM app_artifacts a JOIN app_conversations c ON c.operation_id=a.operation_id
      WHERE c.tenant=? AND c.subject=? AND a.id=? AND a.deleted_at IS NULL`,[o.tenant,o.subject,operationId.parse(id)]);
    return rows[0] ? artifactFromRow(rows[0]) : null;
  }
  async deleteArtifact(owner: AccessOwner,id: string) {
    const o = accessOwner.parse(owner);
    const rows = await this.db.query(`UPDATE app_artifacts SET title='Deleted artifact',content=' ',input_hash=?,deleted_at=? WHERE id=? AND deleted_at IS NULL
      AND operation_id IN (SELECT operation_id FROM app_conversations WHERE tenant=? AND subject=?) RETURNING id`,
      ["0".repeat(64),Date.now(),operationId.parse(id),o.tenant,o.subject]);
    return rows.length === 1;
  }
  async appendProjection(owner: AccessOwner, operation: string, session: string, entry: ProjectionEntry, sourceIndex?: number) {
    const o = accessOwner.parse(owner), id = operationId.parse(operation), sid = sessionId.parse(session), e = projectionEntry.parse(entry), body = JSON.stringify(e);
    const source = sourceIndex === undefined ? null : projectionSourceIndex.parse(sourceIndex);
    const inserted = await this.db.query(`INSERT INTO app_conversation_events (operation_id,event_id,payload,source_index) SELECT operation_id,?,?,? FROM app_conversations WHERE tenant=? AND subject=? AND operation_id=? AND session_id=? AND status='active' ${this.db.lockBinding ? "FOR UPDATE" : ""} ON CONFLICT DO NOTHING RETURNING event_id`,[e.eventId,body,source,o.tenant,o.subject,id,sid]);
    if (inserted.length) return "inserted" as const;
    const binding = "FROM app_conversation_events e JOIN app_conversations c ON c.operation_id=e.operation_id WHERE c.tenant=? AND c.subject=? AND c.operation_id=? AND c.session_id=? AND c.status='active' AND e.event_id=?";
    const values = [o.tenant,o.subject,id,sid,e.eventId];
    const rows = await this.db.query(`SELECT e.payload,e.source_index ${binding}`,values);
    if (!rows.length) {
      if (source === null) return "unavailable" as const;
      const collision = await this.db.query("SELECT e.event_id FROM app_conversation_events e JOIN app_conversations c ON c.operation_id=e.operation_id WHERE c.tenant=? AND c.subject=? AND c.operation_id=? AND c.session_id=? AND c.status='active' AND e.source_index=?",[o.tenant,o.subject,id,sid,source]);
      return collision.length ? "conflict" as const : "unavailable" as const;
    }
    const existing = rows[0] as { payload: string;source_index: number | null };
    if (existing.payload !== body || source !== null && existing.source_index !== null && Number(existing.source_index) !== source) return "conflict" as const;
    if (source !== null && existing.source_index === null) {
      try {
        await this.db.query(`UPDATE app_conversation_events SET source_index=? WHERE event_id=? AND source_index IS NULL AND operation_id IN (SELECT operation_id FROM app_conversations WHERE tenant=? AND subject=? AND operation_id=? AND session_id=? AND status='active') RETURNING event_id`,[source,e.eventId,o.tenant,o.subject,id,sid]);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "23505" || code === "ERR_SQLITE_ERROR" && /UNIQUE constraint failed/.test((error as Error).message)) return "conflict" as const;
        throw error;
      }
      const updated = await this.db.query(`SELECT e.source_index ${binding}`,values);
      if (!updated.length) return "unavailable" as const;
      const updatedSource = (updated[0] as { source_index: number | null }).source_index;
      if (updatedSource === null || Number(updatedSource) !== source) return "conflict" as const;
    }
    return "duplicate" as const;
  }
  async listProjections(owner: AccessOwner, operation: string, options: ProjectionOptions) {
    const o = accessOwner.parse(owner), id = operationId.parse(operation), q = projectionOptions.parse(options);
    const rows = await this.db.query("SELECT e.payload,e.ordinal,e.source_index FROM app_conversation_events e JOIN app_conversations c ON c.operation_id=e.operation_id WHERE c.tenant=? AND c.subject=? AND c.operation_id=? AND e.ordinal>? ORDER BY e.ordinal ASC LIMIT ?",[o.tenant,o.subject,id,q.after ?? 0,q.limit+1]);
    return pageOfProjections(rows.map(row => ({ entry: JSON.parse((row as { payload: string }).payload),index: Number((row as { ordinal: number }).ordinal),sourceIndex: (row as { source_index: string | number | null }).source_index === null ? null : Number((row as { source_index: string | number }).source_index) })),q.limit);
  }
  async getProjectionCheckpoint(owner: AccessOwner, operation: string, session: string) {
    const o = accessOwner.parse(owner),id = operationId.parse(operation),sid = sessionId.parse(session);
    const rows = await this.db.query("SELECT projection_checkpoint FROM app_conversations WHERE tenant=? AND subject=? AND operation_id=? AND session_id=? AND status='active'",[o.tenant,o.subject,id,sid]);
    return rows.length ? projectionSourceIndex.parse(Number((rows[0] as { projection_checkpoint: string | number }).projection_checkpoint)) : null;
  }
  async advanceProjectionCheckpoint(owner: AccessOwner, operation: string, session: string, expected: number, next: number) {
    const o = accessOwner.parse(owner),id = operationId.parse(operation),sid = sessionId.parse(session);
    const from = projectionSourceIndex.parse(expected),to = projectionSourceIndex.parse(next);
    if (to <= from) throw new RangeError("Projection checkpoint must advance.");
    const rows = await this.db.query("UPDATE app_conversations SET projection_checkpoint=? WHERE tenant=? AND subject=? AND operation_id=? AND session_id=? AND status='active' AND projection_checkpoint=? RETURNING operation_id",[to,o.tenant,o.subject,id,sid,from]);
    return rows.length === 1;
  }
  async reserve(input: Reservation, title = "New conversation") {
    const r = reservation.parse(input);
    return (await this.db.query("INSERT INTO app_conversations (id,tenant,subject,operation_id,request_hash,status,title,created_at) VALUES (?,?,?,?,?,'starting',?,?) ON CONFLICT DO NOTHING RETURNING id", [r.id, r.tenant, r.subject, r.operationId, r.requestHash, conversationTitle.parse(title), Date.now()])).length === 1;
  }
  async list(owner: AccessOwner, options: HistoryOptions) {
    const o = accessOwner.parse(owner), q = historyOptions.parse(options);
    const values: (string | number)[] = [o.tenant,o.subject,q.archived ? 1 : 0];
    let after = "";
    if (q.cursor) { const [time,id] = q.cursor.split("."); after = " AND (created_at < ? OR (created_at = ? AND id < ?))"; values.push(Number(time),Number(time),id); }
    values.push(q.limit+1);
    const rows = await this.db.query(`SELECT * FROM app_conversations WHERE tenant=? AND subject=? AND archived=?${after} ORDER BY created_at DESC,id DESC LIMIT ?`,values);
    return pageOfHistory(rows.map(summaryFromRow),q.limit);
  }
  async getDetails(owner: AccessOwner, operation: string) {
    const o = accessOwner.parse(owner);
    const rows = await this.db.query("SELECT * FROM app_conversations WHERE tenant=? AND subject=? AND operation_id=?",[o.tenant,o.subject,operationId.parse(operation)]);
    return rows[0] ? summaryFromRow(rows[0]) : null;
  }
  async updateDetails(owner: AccessOwner, operation: string, patch: HistoryPatch) {
    const o = accessOwner.parse(owner), p = historyPatch.parse(patch);
    const rows = await this.db.query("UPDATE app_conversations SET title=COALESCE(?,title),archived=COALESCE(?,archived),revision=revision+1 WHERE tenant=? AND subject=? AND operation_id=? AND revision=? RETURNING *",[p.title ?? null,p.archived === undefined ? null : p.archived ? 1 : 0,o.tenant,o.subject,operationId.parse(operation),p.revision]);
    return rows[0] ? summaryFromRow(rows[0]) : null;
  }
  async getOperation(owner: AccessOwner, operation: string) {
    const o = accessOwner.parse(owner);
    return fromAccessRow((await this.db.query("SELECT * FROM app_conversations WHERE tenant=? AND subject=? AND operation_id=?", [o.tenant, o.subject, operationId.parse(operation)]))[0]);
  }
  async bind(owner: AccessOwner, operation: string, session: string) {
    const o = accessOwner.parse(owner), id = operationId.parse(operation), target = sessionId.parse(session);
    try {
      const rows = await this.db.query("UPDATE app_conversations SET session_id=?,status='active' WHERE tenant=? AND subject=? AND operation_id=? AND status='starting' AND session_id IS NULL RETURNING id", [target, o.tenant, o.subject, id]);
      if (rows.length) return true;
      const existing = await this.getOperation(o, id);
      return existing?.status === "active" && existing.sessionId === target;
    } catch (error) {
      // Session IDs remain globally unique, including revoked tombstones.
      const code = (error as { code?: string }).code;
      if (code === "23505" || code === "ERR_SQLITE_ERROR" && /UNIQUE constraint failed/.test((error as Error).message)) return false;
      throw error;
    }
  }
  async ownsSession(owner: AccessOwner, session: string) {
    const o = accessOwner.parse(owner);
    return (await this.db.query("SELECT id FROM app_conversations WHERE tenant=? AND subject=? AND session_id=? AND status='active'", [o.tenant, o.subject, sessionId.parse(session)])).length === 1;
  }
  async cancelStarting(owner: AccessOwner, operation: string) {
    const o = accessOwner.parse(owner);
    return (await this.db.query("UPDATE app_conversations SET status='revoked' WHERE tenant=? AND subject=? AND operation_id=? AND status='starting' AND session_id IS NULL RETURNING id", [o.tenant, o.subject, operationId.parse(operation)])).length === 1;
  }
  async revoke(owner: AccessOwner, id: string) {
    const o = accessOwner.parse(owner);
    return (await this.db.query("UPDATE app_conversations SET status='revoked' WHERE tenant=? AND subject=? AND id=? RETURNING id", [o.tenant, o.subject, operationId.parse(id)])).length === 1;
  }
  async claimNonce(id: string, expiresAt: number, now: number) {
    bodyHash.parse(id);
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(expiresAt) || now <= 0 || expiresAt <= now) throw new Error("Invalid nonce retention window.");
    await this.db.query("DELETE FROM app_internal_nonces WHERE expires_at<? AND id IN (SELECT id FROM app_internal_nonces WHERE expires_at<? LIMIT 1000) RETURNING id", [now, now]);
    return (await this.db.query("INSERT INTO app_internal_nonces (id,expires_at) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING id", [id, expiresAt])).length === 1;
  }
  async close() { await this.db.close(); }
}
