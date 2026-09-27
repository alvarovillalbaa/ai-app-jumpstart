import { authenticateDataRequest as authenticate } from "./authenticated-data";
import { AppError } from "./errors";
import { handle,readJson } from "./handler";
import { getPreferenceStore } from "../preferences/store";
import { PreferenceService } from "../preferences/service";
import type { PreferenceStore } from "../preferences/contract";

export function preferenceHandlers(store: () => Promise<PreferenceStore> = getPreferenceStore) {
  async function service(request: Request) {
    const principal = await authenticate(request);
    if (principal.credentialType !== "user") throw new AppError(401,"unauthorized","Sign in with a registered account to manage preferences.");
    return new PreferenceService(store,{ tenant: principal.tenant,subject: principal.subject });
  }
  return { get: (request: Request) => handle(request,async () => Response.json(await (await service(request)).get())),
    update: (request: Request) => handle(request,async () => {
      const s = await service(request);return Response.json(await s.update(await readJson(request,4096)));
    }),
  };
}
