import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { page,recordCreateResult, type AppRecord, type ListInput, type Owner, type RecordInput, type RecordRepository, type RecordUpdate } from "./contract";
import { recordCreationHash } from "./create-request";

type Row = { id: string; title: string; content: string; revision: number; created_at: Date; updated_at: Date };
export class PostgresRepository implements RecordRepository {
  private pool: Pool;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10_000, statement_timeout: 10_000 });
    // Prevent background socket errors from terminating the process; requests still fail explicitly.
    this.pool.on("error", () => console.error(JSON.stringify({ event: "database_pool_error" })));
  }
  private row(r: Row): AppRecord {
    return { id: r.id, title: r.title, content: r.content, revision: r.revision, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() };
  }
  async list(owner: Owner, input: ListInput) {
    const { rows } = await this.pool.query<Row>("SELECT * FROM app_records WHERE tenant=$1 AND subject=$2 AND id::text>$3 ORDER BY id LIMIT $4", [owner.tenant, owner.subject, input.after ?? "", input.limit + 1]);
    return page(rows.map(r => this.row(r)), input.limit);
  }
  async get(owner: Owner, id: string) {
    const { rows } = await this.pool.query<Row>("SELECT * FROM app_records WHERE tenant=$1 AND subject=$2 AND id=$3", [owner.tenant, owner.subject, id]);
    return rows[0] ? this.row(rows[0]) : null;
  }
  async create(owner: Owner, input: RecordInput) {
    const { rows } = await this.pool.query<Row>("INSERT INTO app_records(id,tenant,subject,title,content) VALUES($1,$2,$3,$4,$5) RETURNING *", [randomUUID(), owner.tenant, owner.subject, input.title, input.content]);
    return this.row(rows[0]);
  }
  async createOnce(owner: Owner,key: string,input: RecordInput) {
    const { rows } = await this.pool.query("SELECT app_create_record_once($1,$2,$3,$4,$5,$6,$7) AS result",
      [owner.tenant,owner.subject,key,recordCreationHash(input),randomUUID(),input.title,input.content]);
    return recordCreateResult.parse(rows[0].result);
  }
  async getCreateReceipt(owner: Owner,key: string) {
    const { rows } = await this.pool.query("SELECT record_id,created_at FROM app_record_creates WHERE tenant=$1 AND subject=$2 AND creation_key=$3",[owner.tenant,owner.subject,key]);
    return rows[0] ? { id: rows[0].record_id as string,createdAt: (rows[0].created_at as Date).toISOString() } : null;
  }
  async update(owner: Owner, id: string, input: RecordUpdate) {
    const { rows } = await this.pool.query<Row>("UPDATE app_records SET title=$1,content=$2,revision=revision+1,updated_at=now() WHERE tenant=$3 AND subject=$4 AND id=$5 AND revision=$6 RETURNING *", [input.title, input.content, owner.tenant, owner.subject, id, input.revision]);
    return rows[0] ? this.row(rows[0]) : null;
  }
  async delete(owner: Owner, id: string, revision: number) {
    const { rowCount } = await this.pool.query("DELETE FROM app_records WHERE tenant=$1 AND subject=$2 AND id=$3 AND revision=$4", [owner.tenant, owner.subject, id, revision]);
    return rowCount === 1;
  }
  async health() { await this.pool.query("SELECT id FROM app_records LIMIT 1"); }
  async close() { await this.pool.end(); }
}
