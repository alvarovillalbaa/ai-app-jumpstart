import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sessionAuthorizer } from "../../lib/agent-access/authorize";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { requestHash, signCreation } from "../../lib/agent-access/signing";

const alice = { tenant: "project", subject: "alice" }, bob = { ...alice, subject: "bob" };
const signing = { audience: "agent:test", activeKey: "one", keys: { one: randomBytes(32).toString("hex") } };
let store: ReturnType<typeof sqliteAccessStore>, id: string;
beforeEach(async () => {
  store = sqliteAccessStore(":memory:"); id = randomUUID();
  const operationId = randomUUID();
  await store.reserve({ ...alice, id, operationId, requestHash: "a".repeat(64) }); await store.bind(alice, operationId, "private-session");
});
afterEach(async () => { await store.close(); });
it("checks ownership on every follow-up, approval, stream and control request", async () => {
  for (const [method, suffix] of [["POST", ""], ["GET", "/stream"], ...["cancel", "clear", "compact", "reset"].map(action => ["POST", `/${action}`])]) {
    const request = new Request(`https://app.test/eve/v1/session/private-session${suffix}`, { method, ...(method === "POST" ? { body: JSON.stringify({ inputResponses: { approval: true } }) } : {}) });
    expect(await sessionAuthorizer({ store, signing, identify: async () => alice })(request)).toMatchObject({ principalId: "alice", issuer: "project" });
    for (const stranger of [bob, { ...alice, tenant: "other" }, null]) expect(await sessionAuthorizer({ store, signing, identify: async () => stranger })(request)).toBeNull();
  }
  await store.revoke(alice, id);
  expect(await sessionAuthorizer({ store, signing, identify: async () => alice })(new Request("https://app.test/eve/v1/session/private-session/stream"))).toBeNull();
});
it("rejects public creation even for a verified user, and accepts only signed reserved creation", async () => {
  const operationId = randomUUID(), body = JSON.stringify({ message: "Hello", operationId });
  const identify = vi.fn(async () => alice), auth = sessionAuthorizer({ store, signing, identify });
  expect(await auth(new Request("https://app.test/eve/v1/session", { method: "POST", body }))).toBeNull();
  await store.reserve({ ...alice, id: randomUUID(), operationId, requestHash: requestHash(body) });
    expect(await auth(new Request("https://app.test/eve/v1/session", { method: "POST", body, headers: signCreation(body, alice, signing) }))).toMatchObject({ principalId: "alice", attributes: { creationOperationId: operationId } });
  expect(identify).not.toHaveBeenCalled();
});
it("denies unknown paths, malformed IDs, subagent streams and unsupported methods", async () => {
  const auth = sessionAuthorizer({ store, signing, identify: async () => alice });
  for (const path of ["/session/private-session", "/session/private-session/other", "/session/%2F/stream", "/session/%/stream", "/session/missing/stream", "/session/private-session/subagents/call/child/stream", "/task-input/token"]) expect(await auth(new Request(`https://app.test/eve/v1${path}`))).toBeNull();
  expect(await auth(new Request("https://app.test/eve/v1/info"))).toMatchObject({ principalId: "alice" });
});
it("propagates storage outages without authenticating the caller", async () => {
  vi.spyOn(store, "ownsSession").mockRejectedValue(new Error("storage offline"));
  await expect(sessionAuthorizer({ store, signing, identify: async () => alice })(new Request("https://app.test/eve/v1/session/private-session/stream"))).rejects.toThrow("storage offline");
});
