import { z } from "zod";
import { accessOwner, type AccessOwner } from "../agent-access/contract";
import { uploadId, uploadName, uploadMediaType } from "./schema";

export const DEFAULT_UPLOAD_QUOTA = { maxBytes: 50 * 1024 * 1024, maxFiles: 20 } as const;
export const uploadQuota = z.object({ maxBytes: z.number().int().min(1).max(1_073_741_824), maxFiles: z.number().int().min(1).max(1000) }).strict();
export const uploadReservation = z.object({
  id: uploadId, name: uploadName, mediaType: uploadMediaType,
  size: z.number().int().min(1).max(5 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export const uploadState = z.enum(["pending", "quarantined", "clean", "rejected", "deleting", "deleted"]);
const scanFields = { sha256: z.string().regex(/^[a-f0-9]{64}$/),checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),policyVersion: z.literal(1) };
export const uploadScanDecision = z.discriminatedUnion("status",[
  z.object({ ...scanFields,status: z.literal("clean") }).strict(),
  z.object({ ...scanFields,status: z.literal("rejected"),reason: z.enum(["malware","integrity"]) }).strict(),
]);
export type UploadScanDecision = z.infer<typeof uploadScanDecision>;
const storedUploadEntry = uploadReservation.extend({ state: uploadState }).strict();
export const uploadEntry = storedUploadEntry.extend({ scan: uploadScanDecision.optional() }).strict().superRefine((row,ctx) => {
  if (row.scan && row.scan.sha256 !== row.sha256 ||
      (row.state === "clean" || row.state === "rejected") && row.scan?.status !== row.state) {
    ctx.addIssue({ code: "custom",message: "Upload decision does not match its stored content/state." });
  }
});
/** Storage completion/deletion and scan decisions have distinct durable owners. */
export function withUploadScan(row: unknown,rawScan?: unknown) {
  const stored = storedUploadEntry.parse(row);
  if (rawScan === undefined) return uploadEntry.parse(stored);
  const scan = uploadScanDecision.parse(rawScan);
  return uploadEntry.parse({ ...stored,scan,state: stored.state === "quarantined" ? scan.status : stored.state });
}
export const uploadUsage = z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict();
export const uploadList = z.array(uploadEntry).max(1000);
export const uploadPage = z.object({ items: uploadList, usage: uploadUsage }).strict();
export const uploadReserveResult = z.enum(["reserved", "existing", "quota", "conflict"]);
export const staleUploadCutoff = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const uploadCleanupLimit = z.number().int().min(1).max(100);
export const uploadCleanupBatchSize = z.number().int().min(1).max(99);
export const uploadCleanupCandidate = accessOwner.extend({ id: uploadId,state: z.enum(["pending","deleting"]),createdAt: staleUploadCutoff }).strict();
export const uploadCleanupCandidates = z.array(uploadCleanupCandidate).max(100);
export type UploadReservation = z.infer<typeof uploadReservation>;
export type UploadEntry = z.infer<typeof uploadEntry>;
export type UploadQuota = z.infer<typeof uploadQuota>;

/** Quota stays reserved through deletion until object removal is confirmed. */
export interface UploadCatalog {
  reserve(owner: AccessOwner, input: UploadReservation, quota: UploadQuota): Promise<z.infer<typeof uploadReserveResult>>;
  markStored(owner: AccessOwner, id: string): Promise<boolean>;
  recordScan(owner: AccessOwner,id: string,decision: UploadScanDecision): Promise<boolean>;
  get(owner: AccessOwner, id: string): Promise<UploadEntry | null>;
  list(owner: AccessOwner): Promise<UploadEntry[]>;
  beginDelete(owner: AccessOwner, id: string): Promise<boolean>;
  claimStalePending(owner: AccessOwner, id: string, cutoff: number): Promise<boolean>;
  listCleanupCandidates(cutoff: number, limit: number): Promise<z.infer<typeof uploadCleanupCandidates>>;
  finishDelete(owner: AccessOwner, id: string): Promise<boolean>;
  usage(owner: AccessOwner): Promise<z.infer<typeof uploadUsage>>;
  close(): Promise<void>;
}

export const uploadCatalogCommand = z.discriminatedUnion("operation", [
  accessOwner.extend({ operation: z.literal("upload.reserve"), input: uploadReservation, quota: uploadQuota }).strict(),
  accessOwner.extend({ operation: z.literal("upload.markStored"), id: uploadId }).strict(),
  accessOwner.extend({ operation: z.literal("upload.recordScan"),id: uploadId,decision: uploadScanDecision }).strict(),
  accessOwner.extend({ operation: z.literal("upload.get"), id: uploadId }).strict(),
  accessOwner.extend({ operation: z.literal("upload.list") }).strict(),
  accessOwner.extend({ operation: z.literal("upload.beginDelete"), id: uploadId }).strict(),
  accessOwner.extend({ operation: z.literal("upload.claimStalePending"), id: uploadId,cutoff: staleUploadCutoff }).strict(),
  accessOwner.extend({ operation: z.literal("upload.finishDelete"), id: uploadId }).strict(),
  accessOwner.extend({ operation: z.literal("upload.usage") }).strict(),
  z.object({ operation: z.literal("upload.listCleanupCandidates"),cutoff: staleUploadCutoff,limit: uploadCleanupLimit }).strict(),
]);
