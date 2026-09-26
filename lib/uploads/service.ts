import type { Principal } from "../data/service";
import { AppError } from "../http/errors";
import { uploadId } from "./schema";
import { STALE_PENDING_UPLOAD_MS, UploadIntake } from "./intake";
import type { UploadCatalog } from "./catalog-contract";
import type { PrivateUploadObjects } from "./contract";
import type { UploadScanner } from "./scanner";
import { checkUpload } from "./validation";
import { withDownloadScanSlot } from "./download-admission";
import { uploadDownloadConfigured } from "./download-capability";
import { assertDownloadGrantLive,signUploadDownload,verifyUploadDownload,type DownloadGrant } from "./download-links";

/** Private bytes require a fresh verdict; durable rejection fences stale scans. */
export class UploadService {
  constructor(private catalog: UploadCatalog,private objects: () => Promise<PrivateUploadObjects>,private principal: Principal,
    private scanner: () => Promise<UploadScanner | null> = async () => null,
    private downloadPolicy: string | undefined = process.env.UPLOAD_DOWNLOAD_POLICY) {}
  private async intake(scan = false) { return new UploadIntake(this.catalog,await this.objects(),undefined,scan ? await this.scanner() : null); }
  private owner(scope: "uploads:read" | "uploads:write" | "uploads:download") {
    if (!this.principal.tenant || !this.principal.subject || !this.principal.scopes.includes(scope)) {
      throw new AppError(403,"forbidden","This credential does not permit this operation.");
    }
    return { tenant: this.principal.tenant,subject: this.principal.subject };
  }
  async accept(name: string,mediaType: string,bytes: Uint8Array) {
    const owner = this.owner("uploads:write");
    return (await this.intake(true)).accept(owner,name,mediaType,bytes);
  }
  async list() { return this.catalog.list(this.owner("uploads:read")); }
  async usage() { return this.catalog.usage(this.owner("uploads:read")); }
  async get(rawId: string) {
    const row = await this.catalog.get(this.owner("uploads:read"),uploadId.parse(rawId));
    if (!row || row.state === "deleted") throw new AppError(404,"not_found","Upload not found.");
    return row;
  }
  private async target(rawId: string) {
    const owner = this.owner("uploads:download"),id = uploadId.parse(rawId);
    const row = await this.catalog.get(owner,id);
    if (!row || row.state === "deleted") throw new AppError(404,"not_found","Upload not found.");
    if (row.state === "rejected") throw new AppError(422,"upload_rejected","Upload was rejected. Delete it and upload a new file.");
    if (row.state !== "quarantined" && row.state !== "clean") throw new AppError(409,"upload_busy","Upload is not ready for scanning.");
    if (!uploadDownloadConfigured(process.env,this.downloadPolicy)) {
      throw new AppError(503,"upload_download_disabled","Upload downloads are not enabled on this host.");
    }
    return { owner,id,row };
  }
  async downloadLink(rawId: string) {
    const { owner,id,row } = await this.target(rawId);
    // Issuance is metadata-only; redemption requires a fresh scan, not this link.
    return signUploadDownload(owner,id,row.sha256);
  }
  private async scanned(rawId: string,grant?: DownloadGrant) {
    const { owner,id,row } = await this.target(rawId);
    if (grant && grant.sha256 !== row.sha256) throw new AppError(403,"download_link_invalid","Download link no longer matches this file.");
    if (grant) assertDownloadGrantLive(grant);
    const scanner = await this.scanner();
    if (!scanner) throw new AppError(503,"scanner_unavailable","A configured scanner is required for downloads.");
    return withDownloadScanSlot(owner,async () => {
      if (grant) assertDownloadGrantLive(grant);
      const bytes = await (await this.objects()).get(owner,id);
      if (!bytes) throw new AppError(503,"upload_storage_unavailable","Upload bytes are unavailable.");
      let checked;
      try { checked = checkUpload(row.name,row.mediaType,bytes); }
      catch {
        await this.catalog.recordScan(owner,id,{ status: "rejected",reason: "integrity",sha256: row.sha256,checkedAt: Date.now(),policyVersion: 1 });
        throw new AppError(503,"upload_integrity_failed","Stored upload failed validation.");
      }
      if (checked.size !== row.size || checked.sha256 !== row.sha256) {
        await this.catalog.recordScan(owner,id,{ status: "rejected",reason: "integrity",sha256: row.sha256,checkedAt: Date.now(),policyVersion: 1 });
        throw new AppError(503,"upload_integrity_failed","Stored upload does not match its private metadata.");
      }
      let verdict;
      try { verdict = await scanner.scan(checked.bytes); }
      catch { throw new AppError(503,"scanner_unavailable","Upload scanner is unavailable."); }
      if (verdict === "infected") {
        await this.catalog.recordScan(owner,id,{ status: "rejected",reason: "malware",sha256: row.sha256,checkedAt: Date.now(),policyVersion: 1 });
        throw new AppError(422,"upload_rejected","Upload did not pass malware scanning.");
      }
      if (verdict !== "clean") throw new AppError(503,"scanner_unavailable","Upload scanner is unavailable.");
      if (!await this.catalog.recordScan(owner,id,{ status: "clean",sha256: row.sha256,checkedAt: Date.now(),policyVersion: 1 })) {
        throw new AppError(409,"upload_busy","Upload changed during scanning. Refresh its status.");
      }
      const current = await this.catalog.get(owner,id);
      if (!current || current.state !== "clean" || current.sha256 !== row.sha256) {
        throw new AppError(409,"upload_busy","Upload changed during scanning.");
      }
      if (grant) assertDownloadGrantLive(grant);
      return { row: current,bytes: checked.bytes };
    });
  }
  async download(rawId: string,grant?: string) {
    const verified = grant === undefined ? undefined : verifyUploadDownload(this.owner("uploads:download"),rawId,grant);
    return this.scanned(rawId,verified);
  }
  async scan(rawId: string) { return (await this.scanned(rawId)).row; }
  async delete(rawId: string) {
    const owner = this.owner("uploads:write"),id = uploadId.parse(rawId);
    const row = await this.catalog.get(owner,id);
    if (!row || row.state === "deleted") throw new AppError(404,"not_found","Upload not found.");
    const intake = await this.intake();
    const removed = row.state === "pending"
      ? await intake.removeStalePending(owner,id,Date.now()-STALE_PENDING_UPLOAD_MS)
      : await intake.remove(owner,id);
    if (!removed) throw new AppError(409,"upload_busy","Upload is still being written. Retry later.");
  }
}
