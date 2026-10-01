import type { AuthFn } from "eve/channels/auth";
import { accessOwner, sessionId, type AccessOwner, type SessionAccessStore } from "./contract";
import { createMessage, verifyCreationContext, type SigningSettings } from "./signing";

export type SessionAuthorizerOptions = {
  store: SessionAccessStore;
  signing: SigningSettings;
  /** Must verify a registered user server-side. Record API keys do not grant AI access. */
  identify: (request: Request) => Promise<AccessOwner | null>;
  clock?: () => number;
};

/** One complete auth policy; never append a permissive/OIDC fallback to it. */
export function sessionAuthorizer(options: SessionAuthorizerOptions): AuthFn<Request> {
  return async request => {
    const { pathname } = new URL(request.url);
    let owner: AccessOwner | null;
    let creationOperationId: string | undefined;
    let creationRequestId: string | undefined;
    let cancellation = false;
    if (pathname === "/eve/v1/session" && request.method === "POST") {
      const verified = await verifyCreationContext(request, options.signing, options.store, options.clock);
      owner = verified?.owner ?? null;creationRequestId = verified?.creationRequestId;
      if (owner) creationOperationId = createMessage.parse(await request.clone().json()).operationId;
    } else {
      const info = pathname === "/eve/v1/info" && request.method === "GET";
      const match = /^\/eve\/v1\/session\/([^/]+)(?:\/(stream|cancel|clear|compact|reset))?$/.exec(pathname);
      if (!info && (!match || (match[2] === "stream" ? request.method !== "GET" : request.method !== "POST"))) return null;
      cancellation = !!match && match[2] === "cancel" && request.method === "POST";
      owner = await options.identify(request);
      if (!owner) return null;
      owner = accessOwner.parse(owner);
      if (match) {
        let id: string;
        try { id = sessionId.parse(decodeURIComponent(match[1])); } catch { return null; }
        if (!await options.store.ownsSession(owner, id)) return null;
      }
    }
    if (!owner) return null;
    // A closed account may still cancel an owned live turn, but it cannot read or mutate sessions.
    if (!cancellation && await options.store.isFenced(owner)) return null;
    return { authenticator: "jumpstart", principalType: "user", principalId: owner.subject,
      subject: owner.subject, issuer: owner.tenant, attributes: { tenant: owner.tenant, ...(creationOperationId ? { creationOperationId } : {}),
        ...(creationRequestId ? { creationRequestId } : {}) } };
  };
}
