import { z } from "zod";
import { AppError } from "../http/errors";
import { trustedHttpOrigin } from "../security/origin";

export type PublicAuthSettings = { url: string; publishableKey: string };
export function authSettings(env: NodeJS.ProcessEnv = process.env): PublicAuthSettings | null {
  if (!env.AUTH_PROVIDER || env.AUTH_PROVIDER === "api-key") return null;
  if (env.AUTH_PROVIDER !== "supabase") throw new AppError(503, "auth_unconfigured", "Set AUTH_PROVIDER to api-key or supabase.");
  const invalid = () => new AppError(503, "auth_unconfigured", "Configure SUPABASE_AUTH_URL and SUPABASE_PUBLISHABLE_KEY for sign-in.");
  const origin = trustedHttpOrigin(env.SUPABASE_AUTH_URL ?? env.SUPABASE_URL);
  if (!origin) throw invalid();
  const key = env.SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!key.startsWith("sb_publishable_")) {
    // Legacy anon keys are public. Never serialize a service-role JWT to a page.
    try {
      const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString());
      if (payload.role !== "anon" || key.split(".").length !== 3) throw invalid();
    } catch { throw invalid(); }
  }
  if (!z.string().min(16).max(4096).safeParse(key).success) throw invalid();
  return { url: origin, publishableKey: key };
}

const destinations = new Set(["/account", "/account/password", "/records", "/uploads", "/s", "/conversations"]);
export function safeReturnPath(value: unknown, fallback = "/account") {
  return typeof value === "string" && destinations.has(value) ? value : fallback;
}
