import { verifySupabaseToken } from "../auth/identity";
import type { PublicAuthSettings } from "../auth/settings";
import { AppError } from "../http/errors";

/** Only registered users. Application record keys confer no model access. */
export async function chatIdentity(request: Request, settings: PublicAuthSettings) {
  const match = /^Bearer ([^\s]{1,8192})$/i.exec(request.headers.get("authorization") ?? "");
  if (!match) throw new AppError(401, "unauthorized", "Sign in to continue.");
  const principal = await verifySupabaseToken(match[1], settings);
  return { tenant: principal.tenant, subject: principal.subject };
}
