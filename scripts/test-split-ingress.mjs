import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const caddyImage = "caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d";
const nodeImage = "node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6";
const suffix = randomUUID().slice(0, 12);
const network = `jumpstart-split-${suffix}`;
const eve = `jumpstart-eve-${suffix}`;
const next = `jumpstart-next-${suffix}`;
const ingress = `jumpstart-ingress-${suffix}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 180_000 }).trim();
const cleanup = (...args) => { try { docker(...args); } catch { /* best effort for disposable resources */ } };

let networkCreated = false;
try {
  docker("network", "create", network);
  networkCreated = true;
  docker("run", "--detach", "--rm", "--network", network, "--name", eve,
    "--volume", `${resolve("scripts/fixtures/split-eve-upstream.mjs")}:/fixture.mjs:ro`,
    nodeImage, "node", "/fixture.mjs");
  docker("run", "--detach", "--rm", "--network", network, "--name", next,
    "--volume", `${resolve("scripts/fixtures/split-next-upstream.mjs")}:/fixture.mjs:ro`,
    nodeImage, "node", "/fixture.mjs");
  docker("run", "--detach", "--rm", "--network", network, "--name", ingress,
    "--publish", "127.0.0.1::8080", "--env", `EVE_UPSTREAM=${eve}:4274`, "--env", `NEXT_UPSTREAM=${next}:3000`,
    "--volume", `${resolve("deploy/split-app.Caddyfile")}:/etc/caddy/Caddyfile:ro`, caddyImage);

  const mapped = docker("port", ingress, "8080/tcp");
  assert.match(mapped, /^127\.0\.0\.1:\d+$/);
  const origin = `http://${mapped}`;
  let health;
  for (let attempt = 0; attempt < 40; attempt++) {
    health = await fetch(`${origin}/eve/v1/health?probe=route`, { signal: AbortSignal.timeout(2_000) }).catch(() => null);
    if (health?.ok) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(health?.status, 200, "the Eve health route must bypass Next");
  assert.deepEqual(await health.json(), { status: "ready", query: "route" });

  const callback = await fetch(`${origin}/.well-known/workflow/v1/flow?probe=callback`, {
    method: "POST", body: "workflow-body", headers: {
      authorization: "Bearer probe-only-token", cookie: "probe_session=opaque",
    }, signal: AbortSignal.timeout(5_000),
  });
  assert.equal(callback.status, 200);
  assert.deepEqual(await callback.json(), { body: "workflow-body", query: "callback",
    authorizationForwarded: true, cookieForwarded: true });
  const page = await fetch(`${origin}/records?probe=next`);
  assert.equal(page.status, 200);
  assert.deepEqual(await page.json(), { next: true, path: "/records?probe=next" });
  const api = await fetch(`${origin}/api/v1/records`);
  assert.deepEqual(await api.json(), { next: true, path: "/api/v1/records" });

  const stream = await fetch(`${origin}/eve/v1/session/probe/stream`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = stream.body.getReader();
  const first = await reader.read(), firstAt = Date.now();
  assert.equal(new TextDecoder().decode(first.value), "data: first\n\n");
  const second = await reader.read(), secondAt = Date.now();
  assert.equal(new TextDecoder().decode(second.value), "data: second\n\n");
  assert.ok(secondAt - firstAt >= 250, "the ingress must stream before Eve finishes");
  await reader.cancel();
  console.log("Split ingress passed: Next routes, Eve routes, Workflow callback and live SSE.");
} finally {
  cleanup("rm", "--force", ingress);
  cleanup("rm", "--force", next);
  cleanup("rm", "--force", eve);
  if (networkCreated) cleanup("network", "rm", network);
}
