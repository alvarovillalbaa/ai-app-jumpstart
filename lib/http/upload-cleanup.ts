import { createHash, timingSafeEqual } from "node:crypto";
import { createUploadCatalog } from "../uploads/catalog-store";
import { cleanupUploads } from "../uploads/cleanup";
import { createUploadObjects } from "../uploads/objects-store";
import type { UploadCatalog } from "../uploads/catalog-contract";
import type { PrivateUploadObjects } from "../uploads/contract";

function authorized(request: Request,secret: string) {
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const expectedHash = createHash("sha256").update(secret).digest();
  const suppliedHash = createHash("sha256").update(supplied).digest();
  return supplied.length >= 32 && timingSafeEqual(expectedHash,suppliedHash);
}

export function uploadCleanupHandler(
  catalog: () => Promise<UploadCatalog> = createUploadCatalog,
  objects: () => Promise<PrivateUploadObjects> = createUploadObjects,
  secret: () => string | undefined = () => process.env.CRON_SECRET,
  storageProvider: () => string | undefined = () => process.env.UPLOAD_STORAGE_PROVIDER,
) {
  return async (request: Request) => {
    const key = secret();
    if (!key || key.length < 32) return Response.json({ error: "cleanup_unavailable" },{
      status: 503,headers: { "cache-control": "no-store" },
    });
    if (!authorized(request,key)) return Response.json({ error: "unauthorized" },{
      status: 401,headers: { "cache-control": "no-store" },
    });
    if (!storageProvider()) return Response.json({ status: "storage_disabled" },{
      headers: { "cache-control": "no-store" },
    });
    let store: UploadCatalog | undefined;
    try {
      store = await catalog();
      const result = await cleanupUploads(store,await objects());
      return Response.json(result,{ status: result.failed ? 503 : 200,headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json({ error: "cleanup_failed" },{ status: 503,headers: { "cache-control": "no-store" } });
    } finally { await store?.close().catch(() => console.error(JSON.stringify({ event: "upload_cleanup_catalog_close_failed" }))); }
  };
}
