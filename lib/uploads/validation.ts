import { createHash } from "node:crypto";
import { uploadName, type UploadMediaType } from "./schema";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/** Leave headroom below Vercel's 4.5 MB Function request limit. */
export const MAX_API_UPLOAD_BYTES = 4 * 1024 * 1024;
export type { UploadMediaType } from "./schema";
export type CheckedUpload = { name: string; mediaType: UploadMediaType; size: number; sha256: string; bytes: Uint8Array };

function starts(bytes: Uint8Array, signature: number[]) { return signature.every((value, index) => bytes[index] === value); }
function ends(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[bytes.length - signature.length + index] === value);
}

/** Reject false MIME claims before quarantine; this is not malware scanning. */
export function checkUpload(rawName: string, declaredType: string, rawBytes: Uint8Array): CheckedUpload {
  const name = uploadName.parse(rawName);
  if (!(rawBytes instanceof Uint8Array) || rawBytes.length < 1 || rawBytes.length > MAX_UPLOAD_BYTES) throw new Error("Upload size is outside the allowed range.");
  const bytes = Uint8Array.from(rawBytes);
  let mediaType: UploadMediaType;
  if (declaredType === "text/plain" && /\.txt$/i.test(name)) {
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new Error("Text upload must be valid UTF-8."); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || /^\s*<(?:!doctype\s+html|html\b|svg\b|\?xml\b)/iu.test(text)) {
      throw new Error("Text upload contains active or control content.");
    }
    mediaType = "text/plain";
  } else if (declaredType === "image/png" && /\.png$/i.test(name) &&
      starts(bytes,[137,80,78,71,13,10,26,10]) && ends(bytes,[0,0,0,0,73,69,78,68,174,66,96,130])) {
    mediaType = "image/png";
  } else if (declaredType === "image/jpeg" && /\.jpe?g$/i.test(name) && starts(bytes,[255,216,255]) && ends(bytes,[255,217])) {
    mediaType = "image/jpeg";
  } else if (declaredType === "application/pdf" && /\.pdf$/i.test(name) && starts(bytes,[37,80,68,70,45]) &&
      new TextDecoder("latin1").decode(bytes.subarray(Math.max(0,bytes.length-1024))).includes("%%EOF")) {
    mediaType = "application/pdf";
  } else {
    throw new Error("Upload type, extension and file bytes do not agree.");
  }
  return { name, mediaType, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), bytes };
}
