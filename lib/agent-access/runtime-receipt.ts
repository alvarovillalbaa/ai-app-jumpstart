import type { HookContext } from "eve/hooks";
import { accessOwner, operationId, type SessionAccessStore } from "./contract";
import { emitAudit,runtimeReference,runtimeCreationReference } from "../observability/runtime";

/** Invoked only from the winning runtime's turn.started event, never an HTTP body. */
export async function recordRuntimeSession(store: SessionAccessStore, context: Pick<HookContext, "session">) {
  const auth = context.session.auth.initiator;
  if (auth?.authenticator !== "jumpstart") return;
  const owner = accessOwner.parse({ tenant: auth.issuer, subject: auth.principalId });
  const current = context.session.auth.current;
  if (current?.authenticator !== "jumpstart" || current.issuer !== owner.tenant || current.principalId !== owner.subject) throw new Error("Runtime caller does not own this conversation.");
  const operation = operationId.parse(auth.attributes.creationOperationId);
  if (!await store.bind(owner, operation, context.session.id)) throw new Error("Runtime session ownership could not be recorded.");
  // A secondary diagnostic cannot make an already-bound session fail or retry.
  try {
    const row = await store.getOperation(owner,operation);
    if (row?.sessionId === context.session.id) emitAudit({ event: "runtime_session_bound",schemaVersion: 1,at: Date.now(),...runtimeCreationReference(context),
      conversationId: row.id,operationId: operation,sessionRef: runtimeReference(context.session.id) });
  } catch { /* Ownership is enforced by the binding above, not by telemetry. */ }
}
