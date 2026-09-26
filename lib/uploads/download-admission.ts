import { AppError } from "../http/errors";
import type { AccessOwner } from "../agent-access/contract";

// This bounds simultaneous object reads and ClamAV sockets in one Node process.
// Deployments with multiple processes also need an ingress-level rate limit.
const MAX_ACTIVE_DOWNLOAD_SCANS = 4;
const activeOwners = new Set<string>();

export async function withDownloadScanSlot<T>(owner: AccessOwner, work: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([owner.tenant,owner.subject]);
  if (activeOwners.size >= MAX_ACTIVE_DOWNLOAD_SCANS || activeOwners.has(key)) {
    throw new AppError(429,"upload_download_busy","Too many upload scans are running; retry shortly.");
  }
  activeOwners.add(key);
  try { return await work(); }
  finally { activeOwners.delete(key); }
}
