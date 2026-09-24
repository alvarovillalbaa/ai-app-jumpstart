import type { HookContext } from "eve/hooks";
import { accessOwner, operationId, type SessionAccessStore } from "./contract";

/** Invoked only from the winning runtime's turn.started event, never an HTTP body. */
export async function recordRuntimeSession(store: SessionAccessStore, context: Pick<HookContext, "session">) {
  const auth = context.session.auth.initiator;
  if (auth?.authenticator !== "jumpstart") return;
  const owner = accessOwner.parse({ tenant: auth.issuer, subject: auth.principalId });
  const current = context.session.auth.current;
  if (current?.authenticator !== "jumpstart" || current.issuer !== owner.tenant || current.principalId !== owner.subject) throw new Error("Runtime caller does not own this conversation.");
  const operation = operationId.parse(auth.attributes.creationOperationId);
  if (!await store.bind(owner, operation, context.session.id)) throw new Error("Runtime session ownership could not be recorded.");
}
