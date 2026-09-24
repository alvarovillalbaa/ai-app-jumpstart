import type { MessageStreamEvent } from "eve/client";
import type { HookContext } from "eve/hooks";
import { accessOwner, operationId, type SessionAccessStore } from "./contract";
import { projectionEntry, type ProjectionEntry } from "./projection-contract";

/** Selected finalized stream events, never auth challenges, reasoning or token deltas. */
export function projectEvent(event: MessageStreamEvent): ProjectionEntry | null {
  let payload: ProjectionEntry["payload"];
  switch (event.type) {
    case "turn.started": payload = { kind: "run",state: "running" }; break;
    case "turn.completed": payload = { kind: "run",state: "completed" }; break;
    case "turn.cancelled": payload = { kind: "run",state: "cancelled" }; break;
    case "turn.failed": payload = { kind: "run",state: "failed",code: event.data.code.slice(0,100) }; break;
    case "message.received": payload = { kind: "message",role: "user",parts: event.data.parts?.map(part => part.type === "text" ? { type: "text",text: part.text } : { type: "file",mediaType: part.mediaType,...(part.filename === undefined ? {} : { filename: part.filename }),...(part.size === undefined ? {} : { size: part.size }) }) ?? [{ type: "text",text: event.data.message }] }; break;
    case "message.completed": payload = { kind: "message",role: "assistant",parts: event.data.message === null ? [] : [{ type: "text",text: event.data.message }],finishReason: event.data.finishReason }; break;
    case "actions.requested": payload = { kind: "tool",phase: "requested",value: JSON.parse(JSON.stringify(event.data.actions)) }; break;
    case "action.result": payload = { kind: "tool",phase: "result",value: JSON.parse(JSON.stringify({ result: event.data.result,status: event.data.status })) }; break;
    case "result.completed": payload = { kind: "result",value: JSON.parse(JSON.stringify(event.data.result)) }; break;
    case "context.cleared": payload = { kind: "context",action: "cleared" }; break;
    case "compaction.completed": payload = { kind: "context",action: "compacted" }; break;
    default: return null;
  }
  const data = event.data;
  const base = { schemaVersion: 1 as const,eventId: event.meta.id,at: event.meta.at,turnId: data.turnId,sequence: data.sequence,...("stepIndex" in data ? { stepIndex: data.stepIndex } : {}) };
  if (new TextEncoder().encode(JSON.stringify({ ...base,payload })).byteLength > 49_152) payload = { kind: "omitted",eventType: event.type,reason: "size_limit" };
  return projectionEntry.parse({ ...base,payload });
}

export async function persistRuntimeProjection(store: SessionAccessStore, event: MessageStreamEvent, ctx: Pick<HookContext,"session">) {
  const initiator = ctx.session.auth.initiator, current = ctx.session.auth.current;
  if (initiator?.authenticator !== "jumpstart") return;
  const entry = projectEvent(event);
  if (!entry) return;
  if (current?.authenticator !== "jumpstart" || current.issuer !== initiator.issuer || current.principalId !== initiator.principalId) throw new Error("Projection caller does not own this session.");
  const owner = accessOwner.parse({ tenant: initiator.issuer,subject: initiator.principalId });
  const outcome = await store.appendProjection(owner,operationId.parse(initiator.attributes.creationOperationId),ctx.session.id,entry);
  if (outcome !== "inserted" && outcome !== "duplicate") throw new Error("Runtime projection could not be persisted.");
}
