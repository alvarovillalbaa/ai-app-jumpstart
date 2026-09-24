import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { cancelPendingStart } from "../../lib/agent-access/cancel-start";
import { ConversationBroker } from "../../lib/agent-access/broker";
import { creationBody, requestHash } from "../../lib/agent-access/signing";
import type { SessionAccessStore } from "../../lib/agent-access/contract";
import type { BudgetStore } from "../../lib/budgets/contract";
import { inspectOutstandingStarts } from "../../lib/budgets/outstanding";

export function cancelStartContract(name: string, accessFactory: () => Promise<SessionAccessStore>, budgetFactory: () => Promise<BudgetStore>) {
  describe(`Pending start cancellation: ${name}`, () => {
    let access: SessionAccessStore, budgets: BudgetStore;
    const owner = () => ({ tenant: randomUUID(),subject: "alice" });
    const policy = { id: "cancel-contract",dailyMicros: 100,maxActive: 1,maxPerMinute: 2 };
    beforeEach(async () => { [access,budgets] = await Promise.all([accessFactory(),budgetFactory()]); });
    afterEach(async () => { await Promise.all([access?.close(),budgets?.close()]); });

    it("fences a budget-only operation and prevents a delayed dispatch",async () => {
      const user = owner(),input = { message: "Orphaned start",operationId: randomUUID() };
      const hash = requestHash(creationBody(input).body),dispatch = vi.fn(async () => "candidate");
      const now = Date.now();
      expect(await budgets.reserve({ ...user,operationId: input.operationId,requestHash: hash,estimateMicros: 60,policy,now })).toMatchObject({ status: "reserved" });
      expect(await access.getOperation(user,input.operationId)).toBeNull();
      const inspection = await inspectOutstandingStarts(access,budgets,{ limit: 100,cursor: `${now-1}.${randomUUID()}` });
      expect(inspection.items.find(item => item.operationId === input.operationId)).toMatchObject({ conversationStatus: "missing",attempts: 0 });
      await expect(cancelPendingStart(access,budgets,{ ...user,subject: "bob" },input.operationId)).rejects.toMatchObject({ status: 404 });
      const result = await cancelPendingStart(access,budgets,user,input.operationId);
      expect(result.status).toBe("cancelled");
      expect(await cancelPendingStart(access,budgets,user,input.operationId)).toEqual(result);
      expect(await access.getOperation(user,input.operationId)).toMatchObject({ status: "revoked",requestHash: hash,sessionId: null });
      expect(await access.bind(user,input.operationId,"late-runtime")).toBe(false);
      await expect(new ConversationBroker(access,dispatch).create(user,input)).rejects.toMatchObject({ status: 409,code: "creation_unavailable" });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await budgets.snapshot({ ...user,now: Date.now() })).toMatchObject({ active: 0,reservedMicros: 0,chargedMicros: 0 });
    });

    it("settles zero only when cancellation wins the binding race",async () => {
      const user = owner(),input = { message: "Racing start",operationId: randomUUID() };
      const hash = requestHash(creationBody(input).body);
      await budgets.reserve({ ...user,operationId: input.operationId,requestHash: hash,estimateMicros: 60,policy,now: Date.now() });
      await access.reserve({ ...user,id: randomUUID(),operationId: input.operationId,requestHash: hash });
      const [cancel,bound] = await Promise.allSettled([
        cancelPendingStart(access,budgets,user,input.operationId),
        access.bind(user,input.operationId,"racing-runtime"),
      ]);
      if (bound.status === "fulfilled" && bound.value) {
        expect(cancel).toMatchObject({ status: "rejected",reason: { status: 409,code: "conversation_already_started" } });
        expect(await budgets.snapshot({ ...user,now: Date.now() })).toMatchObject({ active: 1,reservedMicros: 60 });
      } else {
        expect(bound).toMatchObject({ status: "fulfilled",value: false });
        expect(cancel).toMatchObject({ status: "fulfilled",value: { status: "cancelled" } });
        expect(await budgets.snapshot({ ...user,now: Date.now() })).toMatchObject({ active: 0,reservedMicros: 0,chargedMicros: 0 });
      }
    });
  });
}
