import { createHash } from "node:crypto";
import { accessOwner, type AccessOwner } from "../agent-access/contract";
import { uploadId } from "./schema";
export { uploadId, uploadName } from "./schema";

/** The owner is never embedded in a caller-supplied or public object path. */
export function uploadOwnerPrefix(owner: AccessOwner) {
  const checked = accessOwner.parse(owner);
  const namespace = createHash("sha256").update(JSON.stringify([checked.tenant, checked.subject])).digest("hex");
  return `uploads/v1/${namespace}/`;
}

export function uploadObjectKey(owner: AccessOwner, rawId: string) {
  const id = uploadId.parse(rawId);
  return `${uploadOwnerPrefix(owner)}${id}`;
}

export interface PrivateUploadObjects {
  put(owner: AccessOwner, id: string, bytes: Uint8Array): Promise<void>;
  get(owner: AccessOwner, id: string): Promise<Uint8Array | null>;
  delete(owner: AccessOwner, id: string): Promise<boolean>;
}
