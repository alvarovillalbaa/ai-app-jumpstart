import { Client } from "eve/client";
import { z } from "zod";
import { AppError } from "../http/errors";
import { accessOwner, operationId, type AccessOwner, type SessionAccessStore } from "./contract";
import { projectEvent } from "./projection";
import { projectionEntry } from "./projection-contract";

export const sourceEventOptions = z.object({
  startIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-250).default(0),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();

export const sourceEventPage = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("eve-durable-stream"),
  items: z.array(z.object({ ...projectionEntry.shape,sourceIndex: z.number().int().nonnegative() }).strict()),
  scanned: z.number().int().nonnegative(),
  nextIndex: z.number().int().nonnegative(),
  complete: z.boolean(),
}).strict();

/** Read selected safe events in exact Eve stream order; never infer model-history winners. */
export async function readSourceEvents(store: SessionAccessStore,owner: AccessOwner,operation: string,input: unknown,
  origin: string,token: string,signal?: AbortSignal) {
  const o = accessOwner.parse(owner),id = operationId.parse(operation),{ startIndex,limit } = sourceEventOptions.parse(input ?? {});
  const row = await store.getOperation(o,id);
  if (!row) throw new AppError(404,"conversation_not_found","Conversation not found.");
  if (row.status !== "active" || !row.sessionId) throw new AppError(409,"source_events_unavailable","An active session binding is required to read source events.");
  const client = new Client({ host: origin,auth: { bearer: token },redirect: "error" });
  const session = client.sessions.attach(row.sessionId,{ streamIndex: startIndex });
  const deadline = signal ? AbortSignal.any([signal,AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  const items: Array<z.infer<typeof sourceEventPage>["items"][number]> = [];
  let scanned = 0;
  const page = (complete: boolean) => sourceEventPage.parse({
    schemaVersion: 1,source: "eve-durable-stream",items,scanned,nextIndex: startIndex+scanned,complete,
  });
  try {
    for await (const event of session.stream({ follow: false,signal: deadline,streamReconnectPolicy: { reconnect: false } })) {
      deadline.throwIfAborted();
      const entry = projectEvent(event);
      if (entry) items.push({ ...entry,sourceIndex: startIndex+scanned });
      scanned++;
      if (scanned === 250 || items.length === limit) return page(false);
    }
    return page(true);
  } catch {
    throw new AppError(503,"source_events_unavailable","Source events could not be read. Retry after checking the runtime.");
  }
}
