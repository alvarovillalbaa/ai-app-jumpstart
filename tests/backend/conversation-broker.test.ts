import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ConversationBroker, creationTransport, type CreationTransport } from "../../lib/agent-access/broker";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { requestHash } from "../../lib/agent-access/signing";
import { structuredRecordSchema } from "../../lib/agent-access/structured-record";

const alice = { tenant: "org", subject: "alice" }, bob = { ...alice, subject: "bob" };
let store: ReturnType<typeof sqliteAccessStore>;
beforeEach(() => { store = sqliteAccessStore(":memory:"); });
afterEach(async () => { await store.close(); });
it("derives a bounded portable title without changing the dispatched message",async () => {
  const message = "Hello\u0000\n " + "x".repeat(113) + "😀 continuation";
  const input = { message,operationId: randomUUID() }, dispatch = vi.fn<CreationTransport>(async () => "candidate");
  const broker = new ConversationBroker(store,dispatch);
  await broker.create(alice,input);
  const title = (await store.list(alice,{})).items[0].title;
  expect(title.length).toBeLessThanOrEqual(120); expect(title.isWellFormed()).toBe(true);
  expect(title.endsWith("\ufffd")).toBe(true);
  expect(title).not.toContain("\u0000"); expect(title).not.toContain("\n");
  expect(JSON.parse(dispatch.mock.calls[0][0]).message).toBe(message);
});
it("dispatches one concurrent request and only returns a durably owned session", async () => {
  const input = { message: "Hello", operationId: randomUUID() };
  const dispatch = vi.fn(async () => { await store.bind(alice, input.operationId, "runtime-session"); return "runtime-session"; });
  const brokers = [new ConversationBroker(store, dispatch), new ConversationBroker(store, dispatch)];
  await Promise.all(brokers.map(broker => broker.create(alice, input)));
  expect(dispatch).toHaveBeenCalledTimes(1);
  const result = await brokers[1].create(alice, input);
  expect(result).toMatchObject({ status: "active", sessionId: "runtime-session" });
  expect(await store.ownsSession(alice, result.sessionId!)).toBe(true);
  await expect(brokers[0].create(alice, { ...input, message: "Changed" })).rejects.toMatchObject({ status: 409 });
  await expect(brokers[0].create(bob, input)).rejects.toMatchObject({ status: 404 });
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("leaves a lost response pending, then reads a repaired runtime receipt without redispatch", async () => {
  const input = { message: "Hello", operationId: randomUUID() };
  const dispatch = vi.fn(async () => { throw new Error("Connection closed after runtime acceptance"); });
  const broker = new ConversationBroker(store, dispatch);
  expect(await broker.create(alice, input)).toMatchObject({ status: "starting", sessionId: null });
  expect(await broker.create(alice, input)).toMatchObject({ status: "starting" });
  await store.bind(alice, input.operationId, "recovered-session");
  expect(await broker.create(alice, input)).toMatchObject({ status: "active", sessionId: "recovered-session" });
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("does not redispatch after a mapping write outage or a crash before dispatch", async () => {
  const input = { message: "Hello", operationId: randomUUID() };
  const dispatch = vi.fn(async () => {
    // HTTP acceptance can succeed while the runtime's ownership write fails.
    await store.bind(alice, input.operationId, "accepted-session").catch(() => false);
    return "accepted-session";
  });
  const broker = new ConversationBroker(store, dispatch);
  vi.spyOn(store, "bind").mockRejectedValueOnce(new Error("Database unavailable"));
  expect(await broker.create(alice, input)).toMatchObject({ status: "starting", sessionId: null });
  expect(await broker.create(alice, input)).toMatchObject({ status: "starting" });
  expect(dispatch).toHaveBeenCalledTimes(1);
  const crashed = { message: "Crash", operationId: randomUUID() };
  await store.reserve({ ...alice, ...{ id: randomUUID(), operationId: crashed.operationId, requestHash: requestHash(JSON.stringify(crashed)) } });
  expect(await broker.create(alice, crashed)).toMatchObject({ status: "starting" });
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("does not expose an accepted candidate before the winning runtime records ownership", async () => {
  const input = { message: "Hello", operationId: randomUUID() };
  const broker = new ConversationBroker(store, async () => "noncanonical-candidate");
  expect(await broker.create(alice, input)).toMatchObject({ status: "starting", sessionId: null });
  expect(await store.ownsSession(alice, "noncanonical-candidate")).toBe(false);
  await store.bind(alice, input.operationId, "canonical-runtime");
  expect(await broker.read(alice, input.operationId)).toMatchObject({ status: "active", sessionId: "canonical-runtime" });
});
it("returns a runtime-installed canonical mapping and never revives revoked operations", async () => {
  const input = { message: "Hello", operationId: randomUUID() };
  const dispatch = vi.fn(async () => { await store.bind(alice, input.operationId, "canonical"); return "candidate"; });
  const broker = new ConversationBroker(store, dispatch), result = await broker.create(alice, input);
  expect(result.sessionId).toBe("canonical");
  await store.revoke(alice, result.conversationId);
  await expect(broker.create(alice, input)).rejects.toMatchObject({ status: 409 });
  expect(dispatch).toHaveBeenCalledTimes(1);
});
it("validates input before dispatch and uses a fixed signed transport without redirects", async () => {
  const dispatch = vi.fn(async () => "session"), broker = new ConversationBroker(store, dispatch);
  await expect(broker.create(alice, { message: "Hello", operationId: randomUUID(), model: "unrestricted" })).rejects.toThrow();
  expect(dispatch).not.toHaveBeenCalled();
  const signing = { audience: "test", activeKey: "one", keys: { one: "a".repeat(64) } };
  expect(() => creationTransport("http://external.invalid", signing)).toThrow();
  const request = vi.fn<typeof fetch>(async () => Response.json({ ok: true, status: "accepted", sessionId: "runtime" }, { status: 202 }));
  const transport = creationTransport("https://runtime.test", signing, request);
  expect(await transport(JSON.stringify({ message: "Hello", operationId: randomUUID() }), alice)).toBe("runtime");
  expect(String(request.mock.calls[0][0])).toBe("https://runtime.test/eve/v1/session");
  expect(request.mock.calls[0][1]).toMatchObject({ redirect: "error", method: "POST", headers: { "content-type": "application/json" } });
  request.mockResolvedValueOnce(Response.json({ ok: true, sessionId: "fake" }, { status: 200 }));
  await expect(transport(JSON.stringify({ message: "Hello", operationId: randomUUID() }), alice)).rejects.toThrow();
});
it("binds the fixed structured schema to the operation without accepting caller schemas",async () => {
  const dispatch = vi.fn<CreationTransport>(async () => "candidate"),broker = new ConversationBroker(store,dispatch);
  const input = { message: "  Organize these notes  ",operationId: randomUUID(),mode: "structured-record" as const };
  await broker.create(alice,input);
  const wire = JSON.parse(dispatch.mock.calls[0][0]);
  expect(wire).toEqual({ message: "Organize these notes",operationId: input.operationId,outputSchema: structuredRecordSchema });
  expect((await store.getOperation(alice,input.operationId))?.requestHash).toBe(requestHash(JSON.stringify(wire)));
  await expect(broker.create(alice,{ ...input,outputSchema: { type: "string" } })).rejects.toThrow();
  await expect(broker.create(alice,{ ...input,mode: "other" })).rejects.toThrow();
  expect(dispatch).toHaveBeenCalledTimes(1);
});
