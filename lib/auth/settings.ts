import { z } from "zod";
import { AppError } from "../http/errors";

export type PublicAuthSettings = { url: string; publishableKey: string };
export function authSettings(env: NodeJS.ProcessEnv = process.env): PublicAuthSettings | null {
  if (!env.AUTH_PROVIDER || env.AUTH_PROVIDER === "api-key") return null;
  if (env.AUTH_PROVIDER !== "supabase") throw new AppError(503, "auth_unconfigured", "Set AUTH_PROVIDER to api-key or supabase.");
  const invalid = () => new AppError(503, "auth_unconfigured", "Configure SUPABASE_AUTH_URL and SUPABASE_PUBLISHABLE_KEY for sign-in.");
  let url: URL;
  try { url = new URL(env.SUPABASE_AUTH_URL ?? env.SUPABASE_URL ?? ""); } catch { throw invalid(); }
  if (url.origin.length > 180 || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw invalid();
  const key = env.SUPABASE_PUBLISHABLE_KEY ?? "";
  if (!key.startsWith("sb_publishable_")) {
    // Legacy anon keys are public. Never serialize a service-role JWT to a page.
    try {
      const payload = JSON.parse(Buffer.from(key.split(".")[1], "base64url").toString());
      if (payload.role !== "anon" || key.split(".").length !== 3) throw invalid();
    } catch { throw invalid(); }
  }
  if (!z.string().min(16).max(4096).safeParse(key).success) throw invalid();
  return { url: url.origin, publishableKey: key };
}

const destinations = new Set(["/account", "/account/password", "/records", "/s", "/conversations"]);
export function safeReturnPath(value: unknown, fallback = "/account") {
  return typeof value === "string" && destinations.has(value) ? value : fallback;
}
