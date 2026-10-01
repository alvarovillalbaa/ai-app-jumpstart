import { config } from "../config";
import type { PreferenceStore } from "./contract";

let store: Promise<PreferenceStore>|undefined;
export async function createPreferenceStore(): Promise<PreferenceStore> {
  const c = config();
  switch (c.DATA_PROVIDER) {
    case "sqlite": return (await import("./sqlite")).sqlitePreferenceStore(c.SQLITE_PATH);
    case "postgres": return (await import("./postgres")).postgresPreferenceStore(c.DATABASE_URL!,c.DATABASE_POOL_MAX);
    case "supabase": return (await import("./supabase")).supabasePreferenceStore(c.SUPABASE_URL!,c.SUPABASE_SECRET_KEY!);
    case "convex": return (await import("./convex")).convexPreferenceStore(c.CONVEX_SITE_URL!,c.CONVEX_BACKEND_SECRET!);
  }
}
export function getPreferenceStore() {
  store ??= createPreferenceStore().catch(error => { store = undefined;throw error; });return store;
}
