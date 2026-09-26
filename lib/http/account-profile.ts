import { authSettings } from "../auth/settings";
import { profileSnapshot } from "../auth/profile";
import { verifySupabaseIdentity } from "../auth/identity";
import { bearerToken } from "./auth";
import { AppError } from "./errors";
import { handle } from "./handler";

export function accountProfileHandler() {
  return (request: Request) => handle(request, async () => {
    const settings = authSettings();
    if (!settings) throw new AppError(503, "auth_unconfigured", "Configure Supabase sign-in for account profiles.");
    const { user } = await verifySupabaseIdentity(bearerToken(request), settings);
    return Response.json(profileSnapshot(user));
  });
}
