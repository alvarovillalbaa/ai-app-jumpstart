import { authenticateDataRequest } from "./authenticated-data";
import { AppError } from "./errors";
import { handle } from "./handler";
import { getRequestLimitStore } from "../request-limits/store";
import { limitSnapshot,type RequestLimitStore } from "../request-limits/contract";

export function accountRequestLimitHandler(store: () => Promise<RequestLimitStore> = getRequestLimitStore) {
  return (request: Request) => handle(request,async () => {
    const principal = await authenticateDataRequest(request);
    if (principal.credentialType !== "user") throw new AppError(401,"unauthorized","Sign in with a registered account to read request usage.");
    const snapshot = await (await store()).snapshot({ tenant: principal.tenant,subject: principal.subject });
    return Response.json({ snapshot: limitSnapshot.parse(snapshot) });
  });
}
