import { authenticate,bearerToken } from "./auth";
import { chatIdentity } from "../agent-access/identity";
import { verifySupabaseIdentity } from "../auth/identity";
import type { PublicAuthSettings } from "../auth/settings";
import type { Owner } from "../data/contract";
import { AppError } from "./errors";
import { getRequestLimitStore } from "../request-limits/store";
import { requestsPerMinute } from "../request-limits/settings";
import { limitResult,type RequestLimitStore } from "../request-limits/contract";

export async function admitDataRequest(owner: Owner,env: Record<string,string | undefined> = process.env,store: () => Promise<RequestLimitStore> = getRequestLimitStore) {
  const limit = requestsPerMinute(env);
  if (!limit) return;
  let result;
  try { result = limitResult.parse(await (await store()).claim(owner,limit)); }
  catch (error) {
    if (error instanceof AppError && error.code === "configuration_error") throw error;
    throw new AppError(503,"request_limit_unavailable","Request admission is unavailable. Try again later.");
  }
  if (!result.allowed) throw new AppError(429,"request_limit","Too many application requests. Try again later.",result.retryAfterSeconds);
}
export async function authenticateDataRequest(request: Request,env: NodeJS.ProcessEnv = process.env) {
  const principal = await authenticate(request,env);
  await admitDataRequest({ tenant: principal.tenant,subject: principal.subject },env);
  return principal;
}
export async function authenticateAccountData(request: Request,settings: PublicAuthSettings) {
  const owner = await chatIdentity(request,settings);await admitDataRequest(owner);return owner;
}
export async function verifyAccountData(request: Request,settings: PublicAuthSettings) {
  const identity = await verifySupabaseIdentity(bearerToken(request),settings);
  await admitDataRequest({ tenant: identity.principal.tenant,subject: identity.principal.subject });return identity;
}
