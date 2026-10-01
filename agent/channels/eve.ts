import { eveChannel } from "eve/channels/eve";
import { localDev } from "eve/channels/auth";
import { chatSettings } from "../../lib/agent-access/settings";
import { chatIdentity } from "../../lib/agent-access/identity";
import { sessionAuthorizer } from "../../lib/agent-access/authorize";
import { getSessionAccessStore } from "../../lib/agent-access/store";
import { AppError } from "../../lib/http/errors";

const development = localDev();

export default eveChannel({
  // Exclusive modes: enabled account chat NEVER falls back to localDev or OIDC.
  auth: async request => {
    const settings = chatSettings();
    if (!settings) return development(request);
    return sessionAuthorizer({ store: await getSessionAccessStore(), signing: settings.signing,
      identify: async req => {
        try { return await chatIdentity(req, settings.auth); }
        catch (error) { if (error instanceof AppError && error.status === 401) return null; throw error; }
      },
    })(request);
  },
  uploadPolicy: "disabled",
});
