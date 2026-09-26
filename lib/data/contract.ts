import { z } from "zod";

export const recordInput = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().max(32_000),
}).strict();
export const recordUpdate = recordInput.extend({ revision: z.number().int().positive() });
export const recordId = z.string().uuid();
export const recordCreationKey = z.uuid().transform(value => value.toLowerCase());
export const appRecord = recordInput.extend({ id: recordId,revision: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),updatedAt: z.iso.datetime({ offset: true }) }).strict();
export const recordCreateResult = z.discriminatedUnion("status",[
  z.object({ status: z.literal("created"),record: appRecord }).strict(),
  z.object({ status: z.literal("existing"),record: appRecord }).strict(),
  z.object({ status: z.literal("conflict") }).strict(),
  z.object({ status: z.literal("deleted") }).strict(),
]);
export type RecordCreateResult = z.infer<typeof recordCreateResult>;
export type RecordCreateReceipt = { id: string; createdAt: string };
export const listInput = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  after: recordId.optional(),
}).strict();
export type RecordInput = z.infer<typeof recordInput>;
export type RecordUpdate = z.infer<typeof recordUpdate>;
export type ListInput = z.infer<typeof listInput>;
export type Owner = { tenant: string; subject: string };
export type AppRecord = RecordInput & {
  id: string; revision: number; createdAt: string; updatedAt: string;
};
export type RecordPage = { items: AppRecord[]; nextCursor: string | null };

/** Implementations must scope every operation by BOTH owner fields. */
export interface RecordRepository {
  list(owner: Owner, input: ListInput): Promise<RecordPage>;
  get(owner: Owner, id: string): Promise<AppRecord | null>;
  create(owner: Owner, input: RecordInput): Promise<AppRecord>;
  createOnce(owner: Owner, key: string, input: RecordInput): Promise<RecordCreateResult>;
  getCreateReceipt(owner: Owner, key: string): Promise<RecordCreateReceipt | null>;
  update(owner: Owner, id: string, input: RecordUpdate): Promise<AppRecord | null>;
  delete(owner: Owner, id: string, revision: number): Promise<boolean>;
  health(): Promise<void>;
  close(): Promise<void>;
}

export function page(rows: AppRecord[], limit: number): RecordPage {
  return { items: rows.slice(0, limit), nextCursor: rows.length > limit ? rows[limit - 1].id : null };
}
