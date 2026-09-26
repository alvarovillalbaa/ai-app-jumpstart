import { config } from "../config";
import type { RecordRepository } from "./contract";

let repository: Promise<RecordRepository> | undefined;
export async function createRepository(): Promise<RecordRepository> {
  const c = config();
  switch (c.DATA_PROVIDER) {
    case "sqlite": { const { SqliteRepository } = await import("./sqlite"); return new SqliteRepository(c.SQLITE_PATH); }
    case "postgres": { const { PostgresRepository } = await import("./postgres"); return new PostgresRepository(c.DATABASE_URL!); }
    case "supabase": { const { SupabaseRepository } = await import("./supabase"); return new SupabaseRepository(c.SUPABASE_URL!, c.SUPABASE_SECRET_KEY!); }
    case "convex": { const { ConvexRepository } = await import("./convex"); return new ConvexRepository(c.CONVEX_SITE_URL!, c.CONVEX_BACKEND_SECRET!); }
  }
}
export function getRepository() {
  repository ??= createRepository().catch(error => { repository = undefined; throw error; });
  return repository;
}
