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

/** Quarantined bytes leave storage only after an explicit, fresh scan-on-read policy. */
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
  async download(rawId: string) {
    const owner = this.owner("uploads:download"),id = uploadId.parse(rawId);
    const row = await this.catalog.get(owner,id);
    if (!row || row.state === "deleted") throw new AppError(404,"not_found","Upload not found.");
    if (row.state !== "quarantined") throw new AppError(409,"upload_busy","Upload is not ready for scanning.");
    if (!uploadDownloadConfigured(process.env,this.downloadPolicy)) {
      throw new AppError(503,"upload_download_disabled","Upload downloads are not enabled on this host.");
    }
    const scanner = await this.scanner();
    if (!scanner) throw new AppError(503,"scanner_unavailable","A configured scanner is required for downloads.");
    return withDownloadScanSlot(owner,async () => {
      const bytes = await (await this.objects()).get(owner,id);
      if (!bytes) throw new AppError(503,"upload_storage_unavailable","Upload bytes are unavailable.");
      let checked;
      try { checked = checkUpload(row.name,row.mediaType,bytes); }
      catch { throw new AppError(503,"upload_integrity_failed","Stored upload failed validation."); }
      if (checked.size !== row.size || checked.sha256 !== row.sha256) {
        throw new AppError(503,"upload_integrity_failed","Stored upload does not match its private metadata.");
      }
      let verdict;
      try { verdict = await scanner.scan(checked.bytes); }
      catch { throw new AppError(503,"scanner_unavailable","Upload scanner is unavailable."); }
      if (verdict === "infected") throw new AppError(422,"upload_rejected","Upload did not pass malware scanning.");
      if (verdict !== "clean") throw new AppError(503,"scanner_unavailable","Upload scanner is unavailable.");
      const current = await this.catalog.get(owner,id);
      if (!current || current.state !== "quarantined" || current.sha256 !== row.sha256) {
        throw new AppError(409,"upload_busy","Upload changed during scanning.");
      }
      return { row,bytes: checked.bytes };
    });
  }
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
