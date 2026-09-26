import { z } from "zod";
import { AppError } from "./http/errors";
import { trustedHttpOrigin } from "./security/origin";

const schema = z.object({
  DATA_PROVIDER: z.enum(["sqlite", "postgres", "supabase", "convex"]).default("sqlite"),
  SQLITE_PATH: z.string().min(1).default(".data/app.sqlite"),
  DATABASE_URL: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SECRET_KEY: z.string().optional(),
  CONVEX_SITE_URL: z.string().optional(),
  CONVEX_BACKEND_SECRET: z.string().min(32).max(512).optional(),
  APP_ORIGIN: z.string().optional(),
});
export function config(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success) throw new AppError(503, "configuration_error", "Invalid application configuration. Check .env.example.");
  const c = result.data;
  if (env.NODE_ENV === "production" && !c.APP_ORIGIN) throw new AppError(503, "configuration_error", "Set APP_ORIGIN to the public application origin in production.");
  const appOrigin = trustedHttpOrigin(c.APP_ORIGIN ?? "http://localhost:3000");
  const supabaseOrigin = c.SUPABASE_URL === undefined ? undefined : trustedHttpOrigin(c.SUPABASE_URL);
  const convexOrigin = c.CONVEX_SITE_URL === undefined ? undefined : trustedHttpOrigin(c.CONVEX_SITE_URL);
  if (!appOrigin || (c.SUPABASE_URL !== undefined && !supabaseOrigin) || (c.CONVEX_SITE_URL !== undefined && !convexOrigin)) {
    throw new AppError(503, "configuration_error", "Application and provider URLs must be HTTPS origins, except local loopback HTTP.");
  }
  if (c.DATA_PROVIDER === "postgres" && !c.DATABASE_URL) throw new AppError(503, "configuration_error", "DATABASE_URL is required for postgres.");
  if (c.DATA_PROVIDER === "supabase" && (!supabaseOrigin || !c.SUPABASE_SECRET_KEY)) throw new AppError(503, "configuration_error", "SUPABASE_URL and SUPABASE_SECRET_KEY are required for supabase.");
  if (c.DATA_PROVIDER === "convex" && (!convexOrigin || !c.CONVEX_BACKEND_SECRET)) throw new AppError(503, "configuration_error", "CONVEX_SITE_URL and CONVEX_BACKEND_SECRET are required for convex.");
  if (c.DATA_PROVIDER === "sqlite" && (env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME)) throw new AppError(503, "configuration_error", "Select a remote data provider on serverless hosts.");
  return { ...c, APP_ORIGIN: appOrigin, SUPABASE_URL: supabaseOrigin ?? undefined, CONVEX_SITE_URL: convexOrigin ?? undefined };
}
