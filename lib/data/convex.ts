import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ConvexBackend } from "./convex-client";
import { recordId, recordInput,recordCreateResult, type ListInput, type Owner, type RecordInput, type RecordRepository, type RecordUpdate } from "./contract";
import { recordCreationHash } from "./create-request";

const record = recordInput.extend({ id: recordId, revision: z.number().int().positive(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }).strict();
export class ConvexRepository implements RecordRepository {
  private backend: ConvexBackend;
  constructor(siteUrl: string, secret: string, request: typeof fetch = fetch) { this.backend = new ConvexBackend(siteUrl, secret, request); }
  async list(owner: Owner, input: ListInput) {
    return this.backend.call("list", { ...owner, ...input }, z.object({ items: z.array(record).max(100), nextCursor: recordId.nullable() }).strict());
  }
  async get(owner: Owner, id: string) { return this.backend.call("get", { ...owner, id }, record.nullable()); }
  async create(owner: Owner, input: RecordInput) { return this.backend.call("create", { ...owner, ...input, id: randomUUID() }, record); }
  async createOnce(owner: Owner,key: string,input: RecordInput) {
    return this.backend.call("createOnce",{ ...owner,...input,key,hash: recordCreationHash(input),id: randomUUID() },recordCreateResult);
  }
  async getCreateReceipt(owner: Owner,key: string) {
    return this.backend.call("creation",{ ...owner,key },z.object({ id: recordId,createdAt: z.iso.datetime() }).strict().nullable());
  }
  async update(owner: Owner, id: string, input: RecordUpdate) { return this.backend.call("update", { ...owner, ...input, id }, record.nullable()); }
  async delete(owner: Owner, id: string, revision: number) { return this.backend.call("delete", { ...owner, id, revision }, z.boolean()); }
  async health() { await this.backend.call("health", {}, z.object({ ready: z.literal(true) }).strict()); }
  async close() {}
}
