import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "./errors";
import type { Principal } from "../data/service";
import { authSettings } from "../auth/settings";
import { verifySupabaseToken } from "../auth/identity";

const credentials = z.array(z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  tenant: z.string().min(1).max(200),
  subject: z.string().min(1).max(200),
  scopes: z.array(z.enum(["records:read", "records:write", "uploads:read", "uploads:write"])).min(1),
}).strict());

/** Only digests are configured; identity never comes from client payloads. */
export async function authenticate(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Principal & { credentialType: "user" | "api-key" }> {
  const settings = authSettings(env);
  let keys: z.infer<typeof credentials>;
  try { keys = credentials.parse(JSON.parse(env.APP_API_KEYS ?? "[]")); }
  catch { throw new AppError(503, "auth_unconfigured", "Configure APP_API_KEYS before using application data."); }
  if (!keys.length && !settings) throw new AppError(503, "auth_unconfigured", "Configure APP_API_KEYS or Supabase sign-in before using application data.");
  const token = bearerToken(request);
  const digest = createHash("sha256").update(token).digest();
  const key = keys.find(key => timingSafeEqual(digest, Buffer.from(key.sha256, "hex")));
  if (!key && settings) return { ...await verifySupabaseToken(token, settings), credentialType: "user" };
  if (!key) throw new AppError(401, "unauthorized", "A valid bearer credential is required.");
  return { tenant: key.tenant, subject: key.subject, scopes: key.scopes, credentialType: "api-key" };
}

export function bearerToken(request: Request) {
  const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!token || token.length < 32 || token.length > 16384) throw new AppError(401, "unauthorized", "A valid bearer credential is required.");
  return token;
}
