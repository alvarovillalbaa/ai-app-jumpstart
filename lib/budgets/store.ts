import { config } from "../config";
import type { BudgetStore } from "./contract";
let store: Promise<BudgetStore> | undefined;
export async function createBudgetStore(): Promise<BudgetStore> {
  const c = config();
  if (c.DATA_PROVIDER === "sqlite") return (await import("./sqlite")).sqliteBudgetStore(c.SQLITE_PATH);
  const remote = await import("./remote");
  if (c.DATA_PROVIDER === "postgres") return remote.postgresBudgetStore(c.DATABASE_URL!);
  if (c.DATA_PROVIDER === "supabase") return remote.supabaseBudgetStore(c.SUPABASE_URL!, c.SUPABASE_SECRET_KEY!);
  return remote.convexBudgetStore(c.CONVEX_SITE_URL!, c.CONVEX_BACKEND_SECRET!);
}
export function getBudgetStore() {
  store ??= createBudgetStore().catch(error => { store = undefined; throw error; });
  return store;
}
