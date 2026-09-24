import { config } from "../config";
import type { SessionAccessStore } from "./contract";

let store: Promise<SessionAccessStore> | undefined;
export async function createSessionAccessStore(): Promise<SessionAccessStore> {
  const c = config();
  switch (c.DATA_PROVIDER) {
    case "sqlite": return (await import("./sqlite")).sqliteAccessStore(c.SQLITE_PATH);
    case "postgres": return (await import("./postgres")).postgresAccessStore(c.DATABASE_URL!);
    case "supabase": return (await import("./supabase")).supabaseAccessStore(c.SUPABASE_URL!, c.SUPABASE_SECRET_KEY!);
    case "convex": return (await import("./convex")).convexAccessStore(c.CONVEX_SITE_URL!, c.CONVEX_BACKEND_SECRET!);
  }
}
export function getSessionAccessStore() {
  store ??= createSessionAccessStore().catch(error => { store = undefined; throw error; });
  return store;
}
