import { z } from "zod";
import { AppError } from "./http/errors";

const schema = z.object({
  DATA_PROVIDER: z.enum(["sqlite", "postgres", "supabase", "convex"]).default("sqlite"),
  SQLITE_PATH: z.string().min(1).default(".data/app.sqlite"),
  DATABASE_URL: z.string().optional(),
  SUPABASE_URL: z.url().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  CONVEX_SITE_URL: z.url().optional(),
  CONVEX_BACKEND_SECRET: z.string().min(32).max(512).optional(),
  APP_ORIGIN: z.url().default("http://localhost:3000"),
});
export function config(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) throw new AppError(503, "configuration_error", "Invalid application configuration. Check .env.example.");
  const c = result.data;
  if (c.DATA_PROVIDER === "postgres" && !c.DATABASE_URL) throw new AppError(503, "configuration_error", "DATABASE_URL is required for postgres.");
  if (c.DATA_PROVIDER === "supabase" && (!c.SUPABASE_URL || !c.SUPABASE_SECRET_KEY)) throw new AppError(503, "configuration_error", "SUPABASE_URL and SUPABASE_SECRET_KEY are required for supabase.");
  if (c.DATA_PROVIDER === "convex" && (!c.CONVEX_SITE_URL || !c.CONVEX_BACKEND_SECRET)) throw new AppError(503, "configuration_error", "CONVEX_SITE_URL and CONVEX_BACKEND_SECRET are required for convex.");
  if (c.DATA_PROVIDER === "sqlite" && (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME)) throw new AppError(503, "configuration_error", "Select a remote data provider on serverless hosts.");
  return c;
}
