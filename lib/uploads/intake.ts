import { randomUUID } from "node:crypto";
import type { AccessOwner } from "../agent-access/contract";
import { AppError } from "../http/errors";
import type { PrivateUploadObjects } from "./contract";
import { DEFAULT_UPLOAD_QUOTA, uploadQuota, type UploadCatalog, type UploadQuota } from "./catalog-contract";
import { checkUpload } from "./validation";

/** Internal quarantine lifecycle. Only a new catalog reservation may write bytes. */
export class UploadIntake {
  private quota: UploadQuota;
  constructor(private catalog: UploadCatalog, private objects: PrivateUploadObjects, quota: UploadQuota = DEFAULT_UPLOAD_QUOTA) {
    this.quota = uploadQuota.parse(quota);
  }

  async accept(owner: AccessOwner, name: string, declaredType: string, rawBytes: Uint8Array) {
    let file;
    try { file = checkUpload(name,declaredType,rawBytes); }
    catch { throw new AppError(400,"invalid_upload","Upload filename, type or bytes are invalid."); }
    const id = randomUUID();
    const result = await this.catalog.reserve(owner,{ id,name: file.name,mediaType: file.mediaType,size: file.size,
      sha256: file.sha256,createdAt: Date.now() },this.quota);
    if (result === "quota") throw new AppError(429,"upload_quota","Upload storage quota is full.");
    if (result !== "reserved") throw new AppError(409,"upload_conflict","Upload reservation could not be created.");
    try {
      await this.objects.put(owner,id,file.bytes);
      if (!await this.catalog.markStored(owner,id)) throw new Error("Upload metadata could not enter quarantine.");
      const stored = await this.catalog.get(owner,id);
      if (!stored || stored.state !== "quarantined") throw new Error("Upload metadata is unavailable.");
      return stored;
    } catch (error) {
      // A timed-out write may still have stored bytes. Hold quota in `deleting`
      // until cleanup succeeds; a later remove() can retry the same object ID.
      try {
        if (await this.catalog.beginDelete(owner,id)) {
          await this.objects.delete(owner,id);
          await this.catalog.finishDelete(owner,id);
        }
      } catch {
        // This ID remains visible as `deleting` to the owner so deletion can
        // be retried; avoid logging the filename, owner or stored bytes.
        console.error(JSON.stringify({ event: "upload_cleanup_pending",uploadId: id }));
      }
      throw error;
    }
  }

  async get(owner: AccessOwner,id: string) { return this.catalog.get(owner,id); }
  async list(owner: AccessOwner) { return this.catalog.list(owner); }
  async usage(owner: AccessOwner) { return this.catalog.usage(owner); }

  async remove(owner: AccessOwner,id: string) {
    const entry = await this.catalog.get(owner,id);
    if (!entry || entry.state === "pending" || entry.state === "deleted") return false;
    if (!await this.catalog.beginDelete(owner,id)) return false;
    await this.objects.delete(owner,id);
    if (!await this.catalog.finishDelete(owner,id)) throw new Error("Upload deletion could not be finalized.");
    return true;
  }
}
