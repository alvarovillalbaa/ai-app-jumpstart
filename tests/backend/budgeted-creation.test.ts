import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { BudgetedCreation } from "../../lib/budgets/creation";
import { ConversationBroker, type CreationTransport } from "../../lib/agent-access/broker";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { sqliteBudgetStore } from "../../lib/budgets/sqlite";
import { creationBody, requestHash } from "../../lib/agent-access/signing";
import { cancelPendingStart } from "../../lib/agent-access/cancel-start";

const owner = { tenant: "test", subject: "alice" }, policy = { id: "test-policy", dailyMicros: 100, maxActive: 1, maxPerMinute: 2 };
let access: ReturnType<typeof sqliteAccessStore>, budgets: ReturnType<typeof sqliteBudgetStore>;
beforeEach(() => { access = sqliteAccessStore(":memory:"); budgets = sqliteBudgetStore(":memory:"); });
afterEach(async () => { await access.close(); await budgets.close(); });
it("rejects unaffordable work before network dispatch and does not refund ambiguous acceptance", async () => {
  const dispatch = vi.fn(async () => { throw new Error("Response lost"); });
  const service = new BudgetedCreation(new ConversationBroker(access,dispatch),budgets,policy,() => 60);
  const input = { message: "Hello", operationId: randomUUID() };
  expect(await service.create(owner,input)).toMatchObject({ status: "starting" });
  expect(await service.create(owner,input)).toMatchObject({ status: "starting" });
  await expect(service.create(owner,{ ...input, operationId: randomUUID() })).rejects.toMatchObject({ status: 429, code: "daily_limit" });
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ active: 1, reservedMicros: 60 });
});
it("resumes a crash between budget admission and conversation reservation once", async () => {
  const dispatch = vi.fn(async () => "candidate"), broker = new ConversationBroker(access,dispatch);
  const service = new BudgetedCreation(broker,budgets,policy,() => 60);
  const input = { message: "Hello", operationId: randomUUID() };
  vi.spyOn(access,"reserve").mockRejectedValueOnce(new Error("Database interrupted"));
  await expect(service.create(owner,input)).rejects.toThrow("Database interrupted");
  expect(dispatch).not.toHaveBeenCalled();
  await service.create(owner,input); await service.create(owner,input);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(await budgets.snapshot({ ...owner, now: Date.now() })).toMatchObject({ active: 1, reservedMicros: 60 });
});
it("does not dispatch a settled operation or accept client-supplied prices", async () => {
  const dispatch = vi.fn(async () => "candidate"), broker = new ConversationBroker(access,dispatch);
  const service = new BudgetedCreation(broker,budgets,policy,() => 60);
  const input = { message: "Hello", operationId: randomUUID() };
  await expect(service.create(owner,{ ...input, estimateMicros: 0 })).rejects.toThrow();
  await service.create(owner,input);
  await budgets.settle({ ...owner, operationId: input.operationId, actualMicros: null });
  expect(await service.create(owner,input)).toMatchObject({ status: "starting" });
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("fails closed when cost estimates or the budget provider are unavailable", async () => {
  const dispatch = vi.fn(async () => "candidate"), broker = new ConversationBroker(access,dispatch);
  const input = { message: "Hello", operationId: randomUUID() };
  await expect(new BudgetedCreation(broker,budgets,policy,() => NaN).create(owner,input)).rejects.toThrow();
  vi.spyOn(budgets,"reserve").mockRejectedValueOnce(new Error("Budget store offline"));
  await expect(new BudgetedCreation(broker,budgets,policy,() => 60).create(owner,input)).rejects.toThrow("Budget store offline");
  expect(dispatch).not.toHaveBeenCalled();
});
it("reserves the exact signed structured body and keeps repeat submissions idempotent",async () => {
  const dispatch = vi.fn<CreationTransport>(async () => "candidate"),service = new BudgetedCreation(new ConversationBroker(access,dispatch),budgets,policy,() => 60);
  const input = { message: "  Organize notes  ",operationId: randomUUID(),mode: "structured-record" as const };
  await service.create(owner,input);
  await service.create(owner,input);
  expect(dispatch).toHaveBeenCalledTimes(1);
  const body = dispatch.mock.calls[0][0];
  expect((await access.getOperation(owner,input.operationId))?.requestHash).toBe(requestHash(body));
  expect(JSON.parse(body).outputSchema.type).toBe("object");
});
it("cancels an ambiguous unbound start and settles zero idempotently",async () => {
  const dispatch = vi.fn(async () => { throw new Error("Response lost"); });
  const service = new BudgetedCreation(new ConversationBroker(access,dispatch),budgets,policy,() => 60);
  const input = { message: "Hello",operationId: randomUUID() };
  await service.create(owner,input);
  const first = await cancelPendingStart(access,budgets,owner,input.operationId);
  expect(first.status).toBe("cancelled");
  expect(await cancelPendingStart(access,budgets,owner,input.operationId)).toEqual(first);
  expect(await access.bind(owner,input.operationId,"late-runtime")).toBe(false);
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ active: 0,reservedMicros: 0,chargedMicros: 0 });
  await expect(service.create(owner,input)).rejects.toMatchObject({ status: 409,code: "creation_unavailable" });
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("cannot refund an active or foreign start",async () => {
  const service = new BudgetedCreation(new ConversationBroker(access,async () => "candidate"),budgets,policy,() => 60);
  const input = { message: "Hello",operationId: randomUUID() };
  await service.create(owner,input); await access.bind(owner,input.operationId,"active-runtime");
  await expect(cancelPendingStart(access,budgets,owner,input.operationId)).rejects.toMatchObject({ status: 409,code: "conversation_already_started" });
  await expect(cancelPendingStart(access,budgets,{ ...owner,subject: "bob" },input.operationId)).rejects.toMatchObject({ status: 404 });
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ active: 1,reservedMicros: 60 });
});
it("keeps cancelled starts reserved until a failed settlement can be retried",async () => {
  const service = new BudgetedCreation(new ConversationBroker(access,async () => { throw new Error("Response lost"); }),budgets,policy,() => 60);
  const input = { message: "Hello",operationId: randomUUID() };
  await service.create(owner,input);
  vi.spyOn(budgets,"settle").mockRejectedValueOnce(new Error("Budget store offline"));
  await expect(cancelPendingStart(access,budgets,owner,input.operationId)).rejects.toMatchObject({ status: 503,code: "cancellation_reconciliation_required" });
  expect(await access.getOperation(owner,input.operationId)).toMatchObject({ status: "revoked",sessionId: null });
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ active: 1,reservedMicros: 60 });
  expect((await cancelPendingStart(access,budgets,owner,input.operationId)).status).toBe("cancelled");
  expect((await budgets.snapshot({ ...owner,now: Date.now() })).active).toBe(0);
});

it("fences a budget-only orphan before a delayed broker can dispatch",async () => {
  const dispatch = vi.fn(async () => "candidate"), broker = new ConversationBroker(access,dispatch);
  const service = new BudgetedCreation(broker,budgets,policy,() => 60);
  const input = { message: "Hello",operationId: randomUUID() };
  vi.spyOn(access,"reserve").mockRejectedValueOnce(new Error("Conversation store interrupted"));
  await expect(service.create(owner,input)).rejects.toThrow("Conversation store interrupted");
  expect(await access.getOperation(owner,input.operationId)).toBeNull();
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ active: 1,reservedMicros: 60 });
  expect((await cancelPendingStart(access,budgets,owner,input.operationId)).status).toBe("cancelled");
  expect(await access.getOperation(owner,input.operationId)).toMatchObject({ status: "revoked",requestHash: requestHash(creationBody(input).body) });
  await expect(service.create(owner,input)).rejects.toMatchObject({ status: 409,code: "creation_unavailable" });
  expect(dispatch).not.toHaveBeenCalled();
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ active: 0,reservedMicros: 0,chargedMicros: 0 });
});

it("does not reveal a foreign budget-only operation or invent one for a missing ID",async () => {
  const id = randomUUID();
  await budgets.reserve({ ...owner,operationId: id,requestHash: "a".repeat(64),estimateMicros: 60,policy,now: Date.now() });
  await expect(cancelPendingStart(access,budgets,{ ...owner,subject: "bob" },id)).rejects.toMatchObject({ status: 404 });
  await expect(cancelPendingStart(access,budgets,owner,randomUUID())).rejects.toMatchObject({ status: 404 });
  expect(await access.getOperation(owner,id)).toBeNull();
});

it("prevents an in-flight create from dispatching after budget-only cancellation",async () => {
  let enterReserve!: () => void, releaseReserve!: () => void;
  const entered = new Promise<void>(resolve => { enterReserve = resolve; });
  const release = new Promise<void>(resolve => { releaseReserve = resolve; });
  const original = access.reserve.bind(access);
  vi.spyOn(access,"reserve").mockImplementationOnce(async (input,title) => { enterReserve(); await release; return original(input,title); });
  const dispatch = vi.fn(async () => "candidate");
  const service = new BudgetedCreation(new ConversationBroker(access,dispatch),budgets,policy,() => 60);
  const input = { message: "Hello",operationId: randomUUID() };
  const creating = service.create(owner,input);
  await entered;
  try { expect((await cancelPendingStart(access,budgets,owner,input.operationId)).status).toBe("cancelled"); }
  finally { releaseReserve(); }
  await expect(creating).rejects.toMatchObject({ status: 409,code: "creation_unavailable" });
  expect(dispatch).not.toHaveBeenCalled();
  expect(await budgets.snapshot({ ...owner,now: Date.now() })).toMatchObject({ active: 0,reservedMicros: 0,chargedMicros: 0 });
});
