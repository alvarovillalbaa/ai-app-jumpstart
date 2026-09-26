import { z } from "zod";
import { uploadId } from "./schema";

export const UPLOAD_DOWNLOAD_LINK_TTL_MS = 60_000;
export const uploadDownloadGrant = z.string().max(200).regex(/^v1\.[a-zA-Z0-9_-]{1,64}\.[0-9]{1,16}\.[a-f0-9]{64}\.[a-zA-Z0-9_-]{43}$/);
export const uploadDownloadLink = z.object({
  url: z.string().max(300),expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((link,ctx) => {
  // Only the exact application-relative route may receive an owner credential.
  const match = /^\/api\/v1\/uploads\/([^/?#]+)\/download\?grant=([^&#]+)$/.exec(link.url);
  if (!match || !uploadId.safeParse(match[1]).success || !uploadDownloadGrant.safeParse(match[2]).success) {
    ctx.addIssue({ code: "custom",message: "Invalid owner download link." });
  }
});
