import { randomUUID } from "node:crypto";
import { AppError } from "../http/errors";
import type { BudgetStore } from "../budgets/contract";
import { accessOwner, operationId, type AccessOwner, type SessionAccessStore } from "./contract";

/** Cancels only an unbound creation. The runtime must bind before its first model call. */
export async function cancelPendingStart(access: SessionAccessStore, budgets: BudgetStore, rawOwner: AccessOwner, rawOperation: string) {
  const owner = accessOwner.parse(rawOwner), id = operationId.parse(rawOperation);
  if (!await access.getOperation(owner,id)) {
    // A process can die after budget admission but before conversation reserve.
    // Insert the same hashed operation first: a delayed broker then loses its
    // reserve race and cannot dispatch. If it wins, the bind/cancel CAS below
    // still decides whether a zero-cost settlement is safe.
    const budget = await budgets.getReservation({ ...owner, operationId: id });
    if (!budget) throw new AppError(404,"conversation_not_found","Conversation not found.");
    if (budget.status !== "reserved") throw new AppError(409,"creation_unavailable","This conversation cannot be cancelled.");
    await access.reserve({ ...owner, id: randomUUID(), operationId: id, requestHash: budget.requestHash },"Cancelled start");
  }
  const won = await access.cancelStarting(owner,id);
  const row = await access.getOperation(owner,id);
  if (!row) throw new AppError(404,"conversation_not_found","Conversation not found.");
  if (!won && (row.status !== "revoked" || row.sessionId !== null)) throw new AppError(409,"conversation_already_started","This conversation has started; cancel its active turn instead.");
  // A revoked, unbound reservation is safe to retry after a failed budget write.
  // No turn can claim a model attempt before the runtime's binding hook succeeds.
  try {
    if (await budgets.attemptCount({ ...owner, operationId: id }) !== 0 ||
        !await budgets.settle({ ...owner, operationId: id, actualMicros: 0 })) {
      throw new AppError(503,"cancellation_reconciliation_required","The start is cancelled, but its budget still needs reconciliation.");
    }
  } catch {
    throw new AppError(503,"cancellation_reconciliation_required","The start is cancelled, but its budget still needs reconciliation.");
  }
  return { conversationId: row.id, operationId: id, status: "cancelled" as const };
}
