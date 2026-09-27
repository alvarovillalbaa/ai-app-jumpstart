import { z } from "zod";
import { agentUploadReference } from "./review-contract";
import { uploadName } from "./schema";

export const chatUploadReference = agentUploadReference.extend({ name: uploadName }).strict();
export type ChatUploadReference = z.infer<typeof chatUploadReference>;
export const reviewedUploadMessage = z.object({
  format: z.literal("jumpstart.reviewed-upload-message.v1"),
  text: z.string().trim().min(1).max(32_000),
  upload: chatUploadReference,
}).strict();

/** Plain text transport preserves the exact message hash and resumable Eve history. */
export function encodeReviewedUploadMessage(text: string,upload: ChatUploadReference) {
  const encoded = JSON.stringify(reviewedUploadMessage.parse({ format: "jumpstart.reviewed-upload-message.v1",text,upload }));
  if (encoded.length > 32_000) throw new Error("Your message and file reference are too long. Shorten the message before sending.");
  return encoded;
}
export function parseReviewedUploadMessage(text: string) {
  if (text.length > 32_000 || !text.startsWith("{")) return null;
  try { const result = reviewedUploadMessage.safeParse(JSON.parse(text));return result.success ? result.data : null; }
  catch { return null; }
}
