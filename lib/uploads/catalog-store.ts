import { config } from "../config";
import type { UploadCatalog } from "./catalog-contract";

let store: Promise<UploadCatalog> | undefined;
export async function createUploadCatalog(): Promise<UploadCatalog> {
  const c = config();
  if (c.DATA_PROVIDER === "sqlite") return (await import("./catalog-sqlite")).sqliteUploadCatalog(c.SQLITE_PATH);
  const remote = await import("./catalog-remote");
  if (c.DATA_PROVIDER === "postgres") return remote.postgresUploadCatalog(c.DATABASE_URL!);
  if (c.DATA_PROVIDER === "supabase") return remote.supabaseUploadCatalog(c.SUPABASE_URL!,c.SUPABASE_SECRET_KEY!);
  return remote.convexUploadCatalog(c.CONVEX_SITE_URL!,c.CONVEX_BACKEND_SECRET!);
}
export function getUploadCatalog() {
  store ??= createUploadCatalog().catch(error => { store = undefined;throw error; });
  return store;
}
