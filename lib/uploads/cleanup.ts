import type { UploadCatalog } from "./catalog-contract";
import { uploadCleanupBatchSize } from "./catalog-contract";
import type { PrivateUploadObjects } from "./contract";
import { STALE_PENDING_UPLOAD_MS, UploadIntake } from "./intake";

/** One bounded pass; repeat on a schedule until `more` is false. */
export async function cleanupUploads(catalog: UploadCatalog,objects: PrivateUploadObjects,now = Date.now(),rawLimit = 50) {
  const limit = uploadCleanupBatchSize.parse(rawLimit),cutoff = now-STALE_PENDING_UPLOAD_MS;
  if (!Number.isSafeInteger(cutoff) || cutoff < 0) throw new Error("Invalid upload cleanup time.");
  const candidates = await catalog.listCleanupCandidates(cutoff,limit+1);
  const intake = new UploadIntake(catalog,objects);
  let deleted = 0,skipped = 0,failed = 0;
  for (const row of candidates.slice(0,limit)) {
    const owner = { tenant: row.tenant,subject: row.subject };
    try {
      const removed = row.state === "pending"
        ? await intake.removeStalePending(owner,row.id,cutoff)
        : await intake.remove(owner,row.id);
      if (removed) deleted++;
      else skipped++;
    } catch { failed++; }
  }
  return { scanned: Math.min(candidates.length,limit),deleted,skipped,failed,more: candidates.length > limit };
}
