import { AppError } from "../http/errors";
import type { AccessOwner } from "../agent-access/contract";

// This bounds active scanner work and, for stored bytes, the associated object reads.
// Deployments sharing a scanner across processes also need ingress-level limits.
const MAX_ACTIVE_UPLOAD_SCANS = 4;
const activeOwners = new Set<string>();

export async function withUploadScanSlot<T>(owner: AccessOwner, work: () => Promise<T>, busyCode: "upload_scan_busy" | "upload_download_busy" = "upload_scan_busy"): Promise<T> {
  const key = JSON.stringify([owner.tenant,owner.subject]);
  if (activeOwners.size >= MAX_ACTIVE_UPLOAD_SCANS || activeOwners.has(key)) {
    throw new AppError(429,busyCode,"Too many upload scans are running; retry shortly.");
  }
  activeOwners.add(key);
  try { return await work(); }
  finally { activeOwners.delete(key); }
}
