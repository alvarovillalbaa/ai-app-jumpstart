import { accessOwner,type AccessOwner } from "../lib/agent-access/contract";
import { supabaseAuthAdmin } from "./account-auth-admin";

/** Read only the selected registered-user presence; never return identity fields. */
export async function inspectAccountAuth(ownerInput: AccessOwner,env: Record<string,string | undefined>,request: typeof fetch = fetch) {
  const owner = accessOwner.parse(ownerInput);
  if (!env.AUTH_PROVIDER || env.AUTH_PROVIDER === "api-key") {
    if (owner.tenant.startsWith("supabase:"))
      throw new Error("Supabase Auth owner requires AUTH_PROVIDER=supabase and its exact operator configuration.");
    return { authProvider: "api-key",authIdentityApplicable: false,authIdentityPresent: false };
  }
  const { auth } = supabaseAuthAdmin(owner,env,request),result = await auth.getUserById(owner.subject);
  if (result.error?.status === 404)
    return { authProvider: "supabase",authIdentityApplicable: true,authIdentityPresent: false };
  if (result.error || result.data.user?.id !== owner.subject || result.data.user.is_anonymous ||
      result.data.user.role !== "authenticated") throw new Error("Auth user could not be verified for this owner.");
  return { authProvider: "supabase",authIdentityApplicable: true,authIdentityPresent: true };
}
