import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { page, type AppRecord, type ListInput, type Owner, type RecordInput, type RecordRepository, type RecordUpdate } from "./contract";

export class SqliteRepository implements RecordRepository {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS app_records (
        id TEXT PRIMARY KEY, tenant TEXT NOT NULL, subject TEXT NOT NULL,
        title TEXT NOT NULL, content TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS records_owner ON app_records(tenant, subject, id);`);
  }
  private row(row: unknown): AppRecord | null {
    if (!row) return null;
    const r = row as { id: string; title: string; content: string; revision: number; created_at: string; updated_at: string };
    return { id: r.id, title: r.title, content: r.content, revision: r.revision, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  async list(owner: Owner, input: ListInput) {
    const rows = this.db.prepare("SELECT * FROM app_records WHERE tenant=? AND subject=? AND id>? ORDER BY id LIMIT ?")
      .all(owner.tenant, owner.subject, input.after ?? "", input.limit + 1);
    return page(rows.map(r => this.row(r)!), input.limit);
  }
  async get(owner: Owner, id: string) {
    return this.row(this.db.prepare("SELECT * FROM app_records WHERE tenant=? AND subject=? AND id=?").get(owner.tenant, owner.subject, id));
  }
  async create(owner: Owner, input: RecordInput) {
    const id = randomUUID(), now = new Date().toISOString();
    return this.row(this.db.prepare("INSERT INTO app_records (id,tenant,subject,title,content,created_at,updated_at) VALUES (?,?,?,?,?,?,?) RETURNING *")
      .get(id, owner.tenant, owner.subject, input.title, input.content, now, now))!;
  }
  async update(owner: Owner, id: string, input: RecordUpdate) {
    return this.row(this.db.prepare("UPDATE app_records SET title=?,content=?,revision=revision+1,updated_at=? WHERE tenant=? AND subject=? AND id=? AND revision=? RETURNING *")
      .get(input.title, input.content, new Date().toISOString(), owner.tenant, owner.subject, id, input.revision));
  }
  async delete(owner: Owner, id: string, revision: number) {
    return this.db.prepare("DELETE FROM app_records WHERE tenant=? AND subject=? AND id=? AND revision=?").run(owner.tenant, owner.subject, id, revision).changes === 1;
  }
  async health() { this.db.prepare("SELECT id FROM app_records LIMIT 1").get(); }
  async close() { this.db.close(); }
}
