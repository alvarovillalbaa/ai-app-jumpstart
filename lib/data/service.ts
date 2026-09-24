import { z } from "zod";
import { AppError } from "../http/errors";
import { listInput, recordId, recordInput, recordUpdate, type Owner, type RecordRepository } from "./contract";

export type Principal = Owner & { scopes: readonly string[] };
export class RecordService {
  constructor(private repository: RecordRepository, private principal: Principal) {}
  private authorize(scope: string) {
    if (!this.principal.tenant || !this.principal.subject || !this.principal.scopes.includes(scope)) {
      throw new AppError(403, "forbidden", "This credential does not permit this operation.");
    }
    return { tenant: this.principal.tenant, subject: this.principal.subject };
  }
  async list(input: unknown = {}) {
    return this.repository.list(this.authorize("records:read"), listInput.parse(input));
  }
  async get(id: unknown) {
    const row = await this.repository.get(this.authorize("records:read"), recordId.parse(id));
    if (!row) throw new AppError(404, "not_found", "Record not found.");
    return row;
  }
  async create(input: unknown) {
    return this.repository.create(this.authorize("records:write"), recordInput.parse(input));
  }
  async update(id: unknown, input: unknown) {
    const row = await this.repository.update(this.authorize("records:write"), recordId.parse(id), recordUpdate.parse(input));
    if (!row) throw new AppError(409, "write_conflict", "Record unavailable or revision changed. Refresh before retrying.");
    return row;
  }
  async delete(id: unknown, revision: unknown) {
    const deleted = await this.repository.delete(this.authorize("records:write"), recordId.parse(id), z.coerce.number().int().positive().parse(revision));
    if (!deleted) throw new AppError(409, "write_conflict", "Record unavailable or revision changed. Refresh before retrying.");
  }
}
