import { Client } from "eve/client";
import { AppError } from "../http/errors";
import { projectEvent } from "./projection";
import { accessOwner, operationId, type AccessOwner, type SessionAccessStore } from "./contract";
import { projectionSourceIndex } from "./projection-contract";
import { z } from "zod";

export const reconcileInput = z.object({
  startIndex: projectionSourceIndex.max(Number.MAX_SAFE_INTEGER-250).optional(),
  resume: z.boolean().optional(),
}).strict().refine(value => !value.resume || value.startIndex === undefined,"Choose resume or an explicit source index.");
/** Re-read a finite authenticated prefix. No dispatch, budget admission or model call. */
export async function reconcileProjections(store: SessionAccessStore, owner: AccessOwner, operation: string, input: unknown, origin: string, token: string, signal?: AbortSignal) {
  const o = accessOwner.parse(owner), id = operationId.parse(operation), options = reconcileInput.parse(input ?? {});
  const row = await store.getOperation(o,id);
  if (!row) throw new AppError(404,"conversation_not_found","Conversation not found.");
  if (row.status !== "active" || !row.sessionId) throw new AppError(409,"projection_unavailable","An active session binding is required to recover projections.");
  const sessionId = row.sessionId;
  const storedCheckpoint = await store.getProjectionCheckpoint(o,id,sessionId);
  if (storedCheckpoint === null) throw new AppError(409,"projection_unavailable","An active session binding is required to recover projections.");
  let checkpoint: number = storedCheckpoint;
  const startIndex = options.resume ? checkpoint : options.startIndex ?? 0;
  if (startIndex > Number.MAX_SAFE_INTEGER-250) throw new AppError(409,"projection_unavailable","Projection cursor exceeds the supported range.");
  const client = new Client({ host: origin,auth: { bearer: token },redirect: "error" });
  const session = client.sessions.attach(sessionId,{ streamIndex: startIndex });
  const deadline = signal ? AbortSignal.any([signal,AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  let processed = 0,inserted = 0,duplicates = 0;
  const finish = async (complete: boolean) => {
    const nextIndex = startIndex+processed;
    // Only a fully scanned contiguous prefix can advance the durable cursor.
    // A manual replay from a later index never skips an unverified gap.
    if (startIndex <= checkpoint && nextIndex > checkpoint) {
      for (let attempt = 0;attempt < 3;attempt++) {
        if (await store.advanceProjectionCheckpoint(o,id,sessionId,checkpoint,nextIndex)) { checkpoint = nextIndex;break; }
        const latest = await store.getProjectionCheckpoint(o,id,sessionId);
        if (latest === null) throw new Error("Projection binding changed during recovery.");
        checkpoint = latest;
        if (checkpoint >= nextIndex || checkpoint < startIndex) break;
      }
    }
    return { processed,inserted,duplicates,nextIndex,complete,checkpoint };
  };
  try {
    for await (const event of session.stream({ follow: false,signal: deadline,streamReconnectPolicy: { reconnect: false } })) {
      deadline.throwIfAborted();
      const entry = projectEvent(event);
      if (entry) {
        const outcome = await store.appendProjection(o,id,sessionId,entry,startIndex+processed);
        if (outcome === "inserted") inserted++;
        else if (outcome === "duplicate") duplicates++;
        else throw new Error("Projection conflict or revoked binding.");
      }
      processed++;
      if (processed === 250) return await finish(false);
    }
    return await finish(true);
  } catch {
    // Earlier rows may have committed. Restarting from the same cursor is safe.
    throw new AppError(503,"projection_recovery_failed","Projection recovery did not finish. Retry from the same cursor after checking runtime availability.");
  }
}
