import { z } from "zod";

export const uploadId = z.uuid();
export const uploadName = z.string().trim().min(1).max(120).refine(value =>
  !/[\\/\u0000-\u001f\u007f]/u.test(value) &&
  !Array.from(value).some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; }),
"Use a plain filename without path separators or control characters.");
export const uploadMediaType = z.enum(["text/plain", "image/png", "image/jpeg", "application/pdf"]);
export type UploadMediaType = z.infer<typeof uploadMediaType>;
/** Leave headroom below Vercel's 4.5 MB Function request limit. */
export const MAX_API_UPLOAD_BYTES = 4 * 1024 * 1024;
