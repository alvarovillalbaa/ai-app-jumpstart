import { randomUUID } from "node:crypto";
import type { AccessOwner } from "../agent-access/contract";
import { AppError } from "../http/errors";
import type { PrivateUploadObjects } from "./contract";
import { DEFAULT_UPLOAD_QUOTA, uploadQuota, type UploadCatalog, type UploadQuota } from "./catalog-contract";
import { checkUpload } from "./validation";
import type { UploadScanner } from "./scanner";
import { withUploadScanSlot } from "./scan-admission";

export const STALE_PENDING_UPLOAD_MS = 24 * 60 * 60 * 1000;

/** Internal quarantine lifecycle. Only a new catalog reservation may write bytes. */
export class UploadIntake {
  private quota: UploadQuota;
  constructor(private catalog: UploadCatalog, private objects: PrivateUploadObjects, quota: UploadQuota = DEFAULT_UPLOAD_QUOTA,
    private scanner: UploadScanner | null = null) {
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
    let writeStarted = false;
    try {
      if (this.scanner) {
        let verdict;
        try { verdict = await withUploadScanSlot(owner,() => this.scanner!.scan(file.bytes)); }
        catch (error) {
          if (error instanceof AppError && error.code === "upload_scan_busy") throw error;
          throw new AppError(503,"scanner_unavailable","Upload scanner is unavailable.");
        }
        if (verdict === "infected") throw new AppError(422,"upload_rejected","Upload did not pass malware scanning.");
        if (verdict !== "clean") throw new AppError(503,"scanner_unavailable","Upload scanner is unavailable.");
      }
      if (await this.catalog.isFenced(owner)) {
        throw new AppError(409,"upload_conflict","This account cannot accept another upload.");
      }
      writeStarted = true;
      await this.objects.put(owner,id,file.bytes);
      if (!await this.catalog.markStored(owner,id)) throw new Error("Upload metadata could not enter quarantine.");
      const stored = await this.catalog.get(owner,id);
      if (!stored || stored.state !== "quarantined") throw new Error("Upload metadata is unavailable.");
      return stored;
    } catch (error) {
      // A timed-out write may still have stored bytes. Hold quota in `deleting`
      // until cleanup succeeds; a later remove() can retry the same object ID.
      // If a permanent fence landed after reservation, row transitions fail.
      // Remove fresh bytes only while the row is still pending. A quarantined
      // row must keep its matching bytes for the operator's account archive.
      let cleanupComplete = false, objectRemovalAttempted = false;
      const pendingUnderFence = async () => await this.catalog.isFenced(owner) &&
        (await this.catalog.get(owner,id))?.state === "pending";
      try {
        const claimed = await this.catalog.beginDelete(owner,id);
        const fenced = !claimed && writeStarted && await pendingUnderFence();
        if (writeStarted && (claimed || fenced)) {
          objectRemovalAttempted = true;
          await this.objects.delete(owner,id);
        }
        if (claimed) cleanupComplete = await this.catalog.finishDelete(owner,id);
      } catch {
        if (writeStarted && !objectRemovalAttempted) {
          try {
            if (await pendingUnderFence()) {
              objectRemovalAttempted = true;
              await this.objects.delete(owner,id);
            }
          } catch { /* The operator inventory must detect any remaining bytes. */ }
        }
      }
      if (!cleanupComplete) {
        // The row remains pending/deleting for inspection or later cleanup.
        // Avoid logging the filename, owner or stored bytes.
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
  async removeStalePending(owner: AccessOwner,id: string,cutoff: number) {
    if (!await this.catalog.claimStalePending(owner,id,cutoff)) return false;
    await this.objects.delete(owner,id);
    if (!await this.catalog.finishDelete(owner,id)) throw new Error("Stale upload deletion could not be finalized.");
    return true;
  }
}
