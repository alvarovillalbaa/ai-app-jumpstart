import { z } from "zod";
import { projectionEntry, projectionOptions, projectionPage, projectionOutcome, projectionSourceIndex, type ProjectionEntry, type ProjectionOptions } from "./projection-contract";
import { artifactInput, artifactCallId, artifactOptions, artifactPage, artifactSaveResult, artifact, type ArtifactInput, type ArtifactOptions } from "./artifact-contract";

export const accessOwner = z.object({ tenant: z.string().min(1).max(200), subject: z.string().min(1).max(200) }).strict();
export type AccessOwner = z.infer<typeof accessOwner>;
export const operationId = z.uuid();
export const bodyHash = z.string().regex(/^[a-f0-9]{64}$/);
export const sessionId = z.string().min(1).max(512).regex(/^[^/\\\u0000-\u001f]+$/);
export const reservation = accessOwner.extend({ id: z.uuid(), operationId, requestHash: bodyHash }).strict();
export type Reservation = z.infer<typeof reservation>;
export const conversation = reservation.extend({ sessionId: sessionId.nullable(), status: z.enum(["starting", "active", "revoked"]) }).strict();
export type Conversation = z.infer<typeof conversation>;
export const conversationTitle = z.string().trim().min(1).max(120).refine(value =>
  !Array.from(value).some(char => {
    const code = char.codePointAt(0)!;
    return code < 32 || code === 127 || code >= 0xd800 && code <= 0xdfff;
  }),
"Titles must contain well-formed text without control characters.");
export const conversationSummary = z.object({ id: z.uuid(), operationId, title: conversationTitle,
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), archived: z.boolean(),
  revision: z.number().int().positive(), status: conversation.shape.status }).strict();
export type ConversationSummary = z.infer<typeof conversationSummary>;
export const historyCursor = z.string().regex(/^[0-9]{1,16}\.[a-f0-9-]{36}$/).refine(value => {
  const [time,id] = value.split("."); return Number.isSafeInteger(Number(time)) && operationId.safeParse(id).success;
});
export const historyOptions = z.object({ limit: z.number().int().min(1).max(50).default(20), archived: z.boolean().default(false), cursor: historyCursor.optional() }).strict();
export type HistoryOptions = z.input<typeof historyOptions>;
export const historyPage = z.object({ items: z.array(conversationSummary), nextCursor: historyCursor.nullable() }).strict();
export const historyPatch = z.object({ revision: z.number().int().min(1).max(2_147_483_646), title: conversationTitle.optional(), archived: z.boolean().optional() }).strict().refine(value => value.title !== undefined || value.archived !== undefined, "Supply title or archived.");
export type HistoryPatch = z.infer<typeof historyPatch>;
export function pageOfHistory(rows: ConversationSummary[], limit: number) {
  const items = rows.slice(0,limit), last = items.at(-1);
  return historyPage.parse({ items, nextCursor: rows.length > limit && last ? `${last.createdAt}.${last.id}` : null });
}
export function summaryFromRow(value: unknown): ConversationSummary {
  const row = z.object({ id: z.uuid(), operation_id: operationId, title: conversationTitle, created_at: z.coerce.number(), archived: z.union([z.literal(0),z.literal(1)]), revision: z.number(), status: conversation.shape.status }).parse(value);
  return conversationSummary.parse({ id: row.id, operationId: row.operation_id, title: row.title, createdAt: row.created_at, archived: row.archived === 1, revision: row.revision, status: row.status });
}

/** Server-only storage. HTTP metadata edits require a verified owner and revision. */
export interface SessionAccessStore {
  saveArtifact(owner: AccessOwner, operation: string, session: string, callId: string, input: ArtifactInput): Promise<z.infer<typeof artifactSaveResult>>;
  listArtifacts(owner: AccessOwner, options: ArtifactOptions): Promise<z.infer<typeof artifactPage>>;
  getArtifact(owner: AccessOwner, id: string): Promise<z.infer<typeof artifact> | null>;
  deleteArtifact(owner: AccessOwner, id: string): Promise<boolean>;
  appendProjection(owner: AccessOwner, operation: string, session: string, entry: ProjectionEntry, sourceIndex?: number): Promise<z.infer<typeof projectionOutcome>>;
  listProjections(owner: AccessOwner, operation: string, options: ProjectionOptions): Promise<z.infer<typeof projectionPage>>;
  reserve(input: Reservation, title?: string): Promise<boolean>;
  list(owner: AccessOwner, options: HistoryOptions): Promise<z.infer<typeof historyPage>>;
  getDetails(owner: AccessOwner, operation: string): Promise<ConversationSummary | null>;
  updateDetails(owner: AccessOwner, operation: string, patch: HistoryPatch): Promise<ConversationSummary | null>;
  getOperation(owner: AccessOwner, operation: string): Promise<Conversation | null>;
  bind(owner: AccessOwner, operation: string, session: string): Promise<boolean>;
  cancelStarting(owner: AccessOwner, operation: string): Promise<boolean>;
  ownsSession(owner: AccessOwner, session: string): Promise<boolean>;
  revoke(owner: AccessOwner, id: string): Promise<boolean>;
  claimNonce(id: string, expiresAt: number, now: number): Promise<boolean>;
  close(): Promise<void>;
}

export const accessCommand = z.discriminatedUnion("operation", [
  accessOwner.extend({ operation: z.literal("access.saveArtifact"),operationId,sessionId,callId: artifactCallId,input: artifactInput }).strict(),
  accessOwner.extend({ operation: z.literal("access.listArtifacts"),options: artifactOptions }).strict(),
  accessOwner.extend({ operation: z.literal("access.getArtifact"),id: z.uuid() }).strict(),
  accessOwner.extend({ operation: z.literal("access.deleteArtifact"),id: z.uuid() }).strict(),
  accessOwner.extend({ operation: z.literal("access.appendProjection"),operationId,sessionId,entry: projectionEntry,sourceIndex: projectionSourceIndex.optional() }).strict(),
  accessOwner.extend({ operation: z.literal("access.listProjections"),operationId,options: projectionOptions }).strict(),
  reservation.extend({ operation: z.literal("access.reserve"), title: conversationTitle.optional() }).strict(),
  accessOwner.extend({ operation: z.literal("access.list"), options: historyOptions }).strict(),
  accessOwner.extend({ operation: z.literal("access.getDetails"), operationId }).strict(),
  accessOwner.extend({ operation: z.literal("access.updateDetails"), operationId, patch: historyPatch }).strict(),
  accessOwner.extend({ operation: z.literal("access.getOperation"), operationId }).strict(),
  accessOwner.extend({ operation: z.literal("access.bind"), operationId, sessionId }).strict(),
  accessOwner.extend({ operation: z.literal("access.cancelStarting"), operationId }).strict(),
  accessOwner.extend({ operation: z.literal("access.ownsSession"), sessionId }).strict(),
  accessOwner.extend({ operation: z.literal("access.revoke"), id: z.uuid() }).strict(),
  z.object({ operation: z.literal("access.claimNonce"), id: bodyHash, expiresAt: z.number().int().positive(), now: z.number().int().positive() }).strict(),
]);

export function fromAccessRow(value: unknown): Conversation | null {
  if (!value) return null;
  const row = z.object({ id: z.uuid(), tenant: z.string(), subject: z.string(), operation_id: z.uuid(), request_hash: bodyHash, session_id: sessionId.nullable(), status: z.enum(["starting", "active", "revoked"]) }).parse(value);
  return conversation.parse({ id: row.id, tenant: row.tenant, subject: row.subject, operationId: row.operation_id, requestHash: row.request_hash, sessionId: row.session_id, status: row.status });
}
