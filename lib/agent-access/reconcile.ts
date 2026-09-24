import { Client } from "eve/client";
import { AppError } from "../http/errors";
import { projectEvent } from "./projection";
import { accessOwner, operationId, type AccessOwner, type SessionAccessStore } from "./contract";
import { z } from "zod";

export const reconcileInput = z.object({ startIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-250).default(0) }).strict();
/** Re-read a finite authenticated prefix. No dispatch, budget admission or model call. */
export async function reconcileProjections(store: SessionAccessStore, owner: AccessOwner, operation: string, input: unknown, origin: string, token: string, signal?: AbortSignal) {
  const o = accessOwner.parse(owner), id = operationId.parse(operation), { startIndex } = reconcileInput.parse(input);
  const row = await store.getOperation(o,id);
  if (!row) throw new AppError(404,"conversation_not_found","Conversation not found.");
  if (row.status !== "active" || !row.sessionId) throw new AppError(409,"projection_unavailable","An active session binding is required to recover projections.");
  const client = new Client({ host: origin,auth: { bearer: token },redirect: "error" });
  const session = client.sessions.attach(row.sessionId,{ streamIndex: startIndex });
  const deadline = signal ? AbortSignal.any([signal,AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  let processed = 0,inserted = 0,duplicates = 0;
  try {
    for await (const event of session.stream({ follow: false,signal: deadline,streamReconnectPolicy: { reconnect: false } })) {
      deadline.throwIfAborted();
      const entry = projectEvent(event);
      if (entry) {
        const outcome = await store.appendProjection(o,id,row.sessionId,entry);
        if (outcome === "inserted") inserted++;
        else if (outcome === "duplicate") duplicates++;
        else throw new Error("Projection conflict or revoked binding.");
      }
      processed++;
      if (processed === 250) return { processed,inserted,duplicates,nextIndex: startIndex+processed,complete: false };
    }
    return { processed,inserted,duplicates,nextIndex: startIndex+processed,complete: true };
  } catch {
    // Earlier rows may have committed. Restarting from the same cursor is safe.
    throw new AppError(503,"projection_recovery_failed","Projection recovery did not finish. Retry from the same cursor after checking runtime availability.");
  }
}
