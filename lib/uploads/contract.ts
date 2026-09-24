import { createHash } from "node:crypto";
import { z } from "zod";
import { accessOwner, type AccessOwner } from "../agent-access/contract";

export const uploadId = z.uuid();
export const uploadName = z.string().trim().min(1).max(120).refine(value =>
  !/[\\/\u0000-\u001f\u007f]/u.test(value) &&
  !Array.from(value).some(char => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; }),
"Use a plain filename without path separators or control characters.");

/** The owner is never embedded in a caller-supplied or public object path. */
export function uploadObjectKey(owner: AccessOwner, rawId: string) {
  const checked = accessOwner.parse(owner), id = uploadId.parse(rawId);
  const namespace = createHash("sha256").update(JSON.stringify([checked.tenant, checked.subject])).digest("hex");
  return `uploads/v1/${namespace}/${id}`;
}

export interface PrivateUploadObjects {
  put(owner: AccessOwner, id: string, bytes: Uint8Array): Promise<void>;
  get(owner: AccessOwner, id: string): Promise<Uint8Array | null>;
  delete(owner: AccessOwner, id: string): Promise<boolean>;
}
