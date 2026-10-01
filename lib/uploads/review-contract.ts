import { z } from "zod";
import { uploadId } from "./schema";

export const uploadReviewInput = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/),revision: z.number().int().min(0).max(2_147_483_646),approved: z.boolean() }).strict();
export const uploadReviewDecision = uploadReviewInput.extend({ at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional() }).strict().refine(value => !value.approved || value.checkedAt !== undefined,"Approval requires a verified scan.");
export type UploadReviewDecision = z.infer<typeof uploadReviewDecision>;
export const uploadReview = z.object({ id: uploadId,sha256: uploadReviewInput.shape.sha256,
  revision: z.number().int().min(0).max(2_147_483_647),status: z.enum(["unreviewed","approved","revoked"]),
  approvedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  checkedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),policyVersion: z.literal(1),
}).strict().refine(row => row.status === "approved" ? row.approvedAt !== null && row.checkedAt !== null && row.revision > 0 : row.approvedAt === null && row.checkedAt === null,"Review does not match its status.");
export type UploadReview = z.infer<typeof uploadReview>;
/** A reference identifies a reviewed version; it never grants access by itself. */
export const agentUploadReference = z.object({ id: uploadId,sha256: uploadReviewInput.shape.sha256,
  reviewRevision: z.number().int().min(1).max(2_147_483_647) }).strict();
export type AgentUploadReference = z.infer<typeof agentUploadReference>;
export const uploadReviewResult = z.discriminatedUnion("status",[
  z.object({ status: z.literal("updated"),review: uploadReview }).strict(),
  z.object({ status: z.literal("conflict") }).strict(),
  z.object({ status: z.literal("unavailable") }).strict(),
  z.object({ status: z.literal("busy") }).strict(),
]);
export const MAX_EXTRACTED_TEXT_BYTES = 32 * 1024;
export const extractedUploadText = z.object({ id: uploadId,sha256: uploadReviewInput.shape.sha256,reviewRevision: uploadReview.shape.revision,
  mediaType: z.literal("text/plain"),text: z.string().min(1).max(MAX_EXTRACTED_TEXT_BYTES),trust: z.literal("untrusted-user-content"),
}).strict();
/** Stored approvals become ineffective when content leaves the clean state. */
export function reviewOfUpload(row: { id: string;sha256: string;state: string },receipt?: { revision: number;approvedSha256: string | null;approvedAt: number | null;checkedAt: number | null }) {
  const approved = row.state === "clean" && receipt?.approvedSha256 === row.sha256 && receipt.approvedAt !== null && receipt.checkedAt !== null;
  return uploadReview.parse({ id: row.id,sha256: row.sha256,revision: receipt?.revision ?? 0,
    status: approved ? "approved" : receipt ? "revoked" : "unreviewed",approvedAt: approved ? receipt!.approvedAt : null,
    checkedAt: approved ? receipt!.checkedAt : null,policyVersion: 1 });
}
