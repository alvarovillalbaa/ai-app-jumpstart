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
export const uploadState = z.enum(["pending", "quarantined", "deleting", "deleted"]);
export const uploadEntry = uploadReservation.extend({ state: uploadState }).strict();
export const uploadUsage = z.object({ files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict();
export const uploadReserveResult = z.enum(["reserved", "existing", "quota", "conflict"]);
export type UploadReservation = z.infer<typeof uploadReservation>;
export type UploadEntry = z.infer<typeof uploadEntry>;
export type UploadQuota = z.infer<typeof uploadQuota>;

/** Quota stays reserved through deletion until object removal is confirmed. */
export interface UploadCatalog {
  reserve(owner: AccessOwner, input: UploadReservation, quota: UploadQuota): Promise<z.infer<typeof uploadReserveResult>>;
  markStored(owner: AccessOwner, id: string): Promise<boolean>;
  get(owner: AccessOwner, id: string): Promise<UploadEntry | null>;
  beginDelete(owner: AccessOwner, id: string): Promise<boolean>;
  finishDelete(owner: AccessOwner, id: string): Promise<boolean>;
  usage(owner: AccessOwner): Promise<z.infer<typeof uploadUsage>>;
  close(): Promise<void>;
}

export const uploadCatalogCommand = z.discriminatedUnion("operation", [
  accessOwner.extend({ operation: z.literal("upload.reserve"), input: uploadReservation, quota: uploadQuota }).strict(),
  accessOwner.extend({ operation: z.literal("upload.markStored"), id: uploadId }).strict(),
  accessOwner.extend({ operation: z.literal("upload.get"), id: uploadId }).strict(),
  accessOwner.extend({ operation: z.literal("upload.beginDelete"), id: uploadId }).strict(),
  accessOwner.extend({ operation: z.literal("upload.finishDelete"), id: uploadId }).strict(),
  accessOwner.extend({ operation: z.literal("upload.usage") }).strict(),
]);
