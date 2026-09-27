import { accessOwner,operationId,sessionId,type SessionAccessStore,type AccessOwner } from "../agent-access/contract";
import { AppError } from "../http/errors";
import { uploadDownloadConfigured } from "./download-capability";
import { uploadStorageEnabled } from "./provider";
import { agentUploadReference,extractedUploadText,type AgentUploadReference } from "./review-contract";
import type { UploadService } from "./service";

export { agentUploadReference,type AgentUploadReference } from "./review-contract";
export type UploadReaderSession = { id: string;auth: {
  initiator?: { authenticator: string;issuer?: string;principalId: string;attributes: Record<string,unknown> } | null;
  current?: { authenticator: string;issuer?: string;principalId: string } | null;
} };
export function uploadReaderEnabled(env: Record<string,string | undefined> = process.env) {
  if (!env.UPLOAD_AGENT_POLICY || env.UPLOAD_AGENT_POLICY === "off") return false;
  if (env.UPLOAD_AGENT_POLICY !== "reviewed-text" || !uploadDownloadConfigured(env) ||
      !uploadStorageEnabled(env.UPLOAD_STORAGE_PROVIDER) ||
      !["clamd","remote"].includes(env.UPLOAD_SCANNER_PROVIDER ?? "")) {
    throw new AppError(503,"configuration_error","Reviewed agent uploads require private storage and scan-on-read.");
  }
  return true;
}
export function uploadReaderOwner(session: UploadReaderSession): AccessOwner | null {
  const first = session.auth.initiator,current = session.auth.current;
  if (first?.authenticator !== "jumpstart" || current?.authenticator !== "jumpstart" ||
      first.issuer !== current.issuer || first.principalId !== current.principalId) return null;
  const owner = accessOwner.safeParse({ tenant: first.issuer,subject: first.principalId });
  return owner.success ? owner.data : null;
}
/** Caller identity and the creation binding never come from tool/model input. */
export class AgentUploadReader {
  constructor(private access: SessionAccessStore,private uploads: (owner: AccessOwner) => Promise<UploadService>,
    private enabled: () => boolean = uploadReaderEnabled) {}
  private async binding(session: UploadReaderSession) {
    if (!this.enabled()) throw new AppError(503,"upload_download_disabled","Agent file reading is disabled on this host.");
    const owner = uploadReaderOwner(session),operation = operationId.safeParse(session.auth.initiator?.attributes.creationOperationId);
    if (!owner || !operation.success) throw new AppError(403,"forbidden","Only the active conversation owner may read a private upload.");
    const row = await this.access.getOperation(owner,operation.data);
    if (!row || row.status !== "active" || row.sessionId !== sessionId.parse(session.id)) {
      throw new AppError(403,"forbidden","Only the active conversation owner may read a private upload.");
    }
    return owner;
  }
  async authorize(session: UploadReaderSession,input: AgentUploadReference) {
    const reference = agentUploadReference.parse(input),owner = await this.binding(session),uploads = await this.uploads(owner);
    const review = await uploads.review(reference.id);
    if (review.status !== "approved" || review.sha256 !== reference.sha256 || review.revision !== reference.reviewRevision) {
      throw new AppError(409,"upload_review_conflict","This upload reference is no longer approved. Refresh its review and request a new approval.");
    }
    return { owner,uploads,reference };
  }
  async read(session: UploadReaderSession,input: AgentUploadReference) {
    const { uploads,reference } = await this.authorize(session,input);
    const text = extractedUploadText.parse(await uploads.extractText(reference.id));
    await this.binding(session);
    const current = await uploads.review(reference.id);
    if (text.sha256 !== reference.sha256 || text.reviewRevision !== reference.reviewRevision ||
        current.status !== "approved" || current.sha256 !== reference.sha256 || current.revision !== reference.reviewRevision) {
      throw new AppError(409,"upload_review_conflict","Upload review changed. No text was released to the agent.");
    }
    return text;
  }
}
