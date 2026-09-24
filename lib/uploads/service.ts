import type { Principal } from "../data/service";
import { AppError } from "../http/errors";
import { uploadId } from "./schema";
import { STALE_PENDING_UPLOAD_MS, UploadIntake } from "./intake";
import type { UploadCatalog } from "./catalog-contract";
import type { PrivateUploadObjects } from "./contract";
import type { UploadScanner } from "./scanner";

/** The public service exposes metadata only; quarantined bytes have no read route. */
export class UploadService {
  constructor(private catalog: UploadCatalog,private objects: () => Promise<PrivateUploadObjects>,private principal: Principal,
    private scanner: () => Promise<UploadScanner | null> = async () => null) {}
  private async intake(scan = false) { return new UploadIntake(this.catalog,await this.objects(),undefined,scan ? await this.scanner() : null); }
  private owner(scope: "uploads:read" | "uploads:write") {
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
