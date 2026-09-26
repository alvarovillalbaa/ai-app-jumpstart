import { afterEach, beforeEach, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { sqliteAccessStore } from "../../lib/agent-access/sqlite";
import { requestHash, signCreation, verifyCreation, type SigningSettings } from "../../lib/agent-access/signing";

const owner = { tenant: "project", subject: "alice" }, now = Date.now();
const config: SigningSettings = { audience: "agent:test", activeKey: "current", keys: { current: randomBytes(32).toString("hex"), previous: randomBytes(32).toString("hex") } };
let store: ReturnType<typeof sqliteAccessStore>, body: string, operationId: string;
beforeEach(async () => {
  store = sqliteAccessStore(":memory:"); operationId = randomUUID(); body = JSON.stringify({ message: "Hello", operationId });
  await store.reserve({ ...owner, id: randomUUID(), operationId, requestHash: requestHash(body) });
});
afterEach(async () => { await store.close(); });
function request(headers = signCreation(body, owner, config, now), payload = body, path = "/eve/v1/session") {
  return new Request(`https://runtime.test${path}`, { method: "POST", headers, body: payload });
}
it("checks the exact reserved body, accepts once across concurrent replicas, and leaves the body readable", async () => {
  const headers = signCreation(body, owner, config, now), original = request(headers);
  const results = await Promise.all([verifyCreation(original, config, store, () => now), verifyCreation(request(headers), config, store, () => now)]);
  expect(results.filter(Boolean)).toEqual([owner]);
  expect(await original.text()).toBe(body);
  expect(await verifyCreation(request(headers), config, store, () => now)).toBeNull();
  expect(await verifyCreation(request(), config, store, () => now)).toEqual(owner);
});
it("rejects altered signatures, payloads, operation IDs, methods, paths, queries and audiences", async () => {
  const headers = signCreation(body, owner, config, now);
  const tampered = { ...headers, "x-jumpstart-signature": "A".repeat(43) };
  for (const invalid of [request(tampered), request(headers, body + " "), request(headers, JSON.stringify({ message: "Hello", operationId: randomUUID() })), request(headers, body, "/eve/v1/session/other"), request(headers, body, "/eve/v1/session?other=1"), new Request("https://runtime.test/eve/v1/session", { headers })]) {
    expect(await verifyCreation(invalid, config, store, () => now)).toBeNull();
  }
  expect(await verifyCreation(request(headers), { ...config, audience: "another-agent" }, store, () => now)).toBeNull();
  expect(await verifyCreation(request(headers), config, store, () => now)).toEqual(owner);
});
it("rejects stale/future signatures, owner mismatches, unreserved content and already-bound operations", async () => {
  for (const at of [now - 60000, now + 5001]) expect(await verifyCreation(request(signCreation(body, owner, config, at)), config, store, () => now)).toBeNull();
  expect(await verifyCreation(request(signCreation(body, { ...owner, subject: "bob" }, config, now)), config, store, () => now)).toBeNull();
  const changed = JSON.stringify({ message: "Changed", operationId });
  expect(await verifyCreation(request(signCreation(changed, owner, config, now), changed), config, store, () => now)).toBeNull();
  await store.bind(owner, operationId, "session");
  expect(await verifyCreation(request(), config, store, () => now)).toBeNull();
});
it("allows a retained rotation key and rejects a removed key", async () => {
  const headers = signCreation(body, owner, { ...config, activeKey: "previous" }, now);
  expect(await verifyCreation(request(headers), { ...config, keys: { current: config.keys.current } }, store, () => now)).toBeNull();
  expect(await verifyCreation(request(headers), config, store, () => now)).toEqual(owner);
});
it("rejects forwarding assertions at the signer boundary", () => {
  expect(() => signCreation(JSON.stringify({ message: "Hello", operationId, principal: "victim" }), owner, config, now)).toThrow();
});
