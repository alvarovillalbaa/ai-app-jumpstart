import { config } from "../config";
import type { RequestLimitStore } from "./contract";
let store: Promise<RequestLimitStore>|undefined;
export async function createRequestLimitStore(): Promise<RequestLimitStore> {
  const c = config();
  if (c.DATA_PROVIDER === "sqlite") return (await import("./sqlite")).sqliteRequestLimitStore(c.SQLITE_PATH);
  const remote = await import("./remote");
  if (c.DATA_PROVIDER === "postgres") return remote.postgresRequestLimitStore(c.DATABASE_URL!,c.DATABASE_POOL_MAX);
  if (c.DATA_PROVIDER === "supabase") return remote.supabaseRequestLimitStore(c.SUPABASE_URL!,c.SUPABASE_SECRET_KEY!);
  return remote.convexRequestLimitStore(c.CONVEX_SITE_URL!,c.CONVEX_BACKEND_SECRET!);
}
export function getRequestLimitStore() {
  store ??= createRequestLimitStore().catch(error => { store = undefined;throw error; });return store;
}
