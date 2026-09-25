import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const nodeImage = "node@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6";
const suffix = randomUUID().slice(0, 12);
const caddyImage = `jumpstart-ingress-test:${suffix}`;
const app = `jumpstart-app-${suffix}`;
const ingress = `jumpstart-ingress-${suffix}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", timeout: 180_000 }).trim();
const cleanup = (...args) => { try { docker(...args); } catch { /* best effort for disposable resources */ } };

const readManifest = path => JSON.parse(readFileSync(resolve(path), "utf8"));
const aws = readManifest("deploy/aws/task-definition.example.json");
const azure = readManifest("deploy/azure/container-app.example.json");
const gcp = readManifest("deploy/gcp/service.example.json");
const cloudRoutes = [
  { app: aws.containerDefinitions.find(c => c.name === "app"), ingress: aws.containerDefinitions.find(c => c.name === "ingress"), port: aws.containerDefinitions.find(c => c.name === "ingress")?.portMappings?.[0]?.containerPort },
  { app: azure.properties.template.containers.find(c => c.name === "app"), ingress: azure.properties.template.containers.find(c => c.name === "ingress"), port: azure.properties.configuration.ingress.targetPort },
  { app: gcp.spec.template.spec.containers.find(c => c.name === "app"), ingress: gcp.spec.template.spec.containers.find(c => c.name === "ingress"), port: gcp.spec.template.spec.containers.find(c => c.name === "ingress")?.ports?.[0]?.containerPort },
];
for (const { app, ingress: proxy, port } of cloudRoutes) {
  assert.equal(port, 8080, "public ingress must target Caddy");
  assert.equal(proxy.image, "REPLACE_WITH_INGRESS_IMAGE_AT_SHA256_DIGEST");
  const env = proxy.environment ?? proxy.env;
  assert.equal(env.find(e => e.name === "NEXT_UPSTREAM")?.value, "127.0.0.1:3000");
  assert.equal(env.find(e => e.name === "EVE_UPSTREAM")?.value, "127.0.0.1:4274");
  const appEnv = app.environment ?? app.env;
  assert.equal(appEnv.find(e => e.name === "APP_AGENT_READINESS")?.value, "local");
}
assert.equal(aws.containerDefinitions.find(c => c.name === "ingress").dependsOn[0].condition, "HEALTHY");
assert.deepEqual(JSON.parse(gcp.spec.template.metadata.annotations["run.googleapis.com/container-dependencies"]), { ingress: ["app"] });

try {
  docker("build", "--file", "deploy/ingress.Dockerfile", "--tag", caddyImage, ".");
  docker("run", "--detach", "--rm", "--name", app, "--publish", "127.0.0.1::8080",
    "--volume", `${resolve("scripts/fixtures/split-eve-upstream.mjs")}:/eve.mjs:ro`,
    "--volume", `${resolve("scripts/fixtures/split-next-upstream.mjs")}:/next.mjs:ro`,
    nodeImage, "node", "--input-type=module", "-e", "await import('/eve.mjs'); await import('/next.mjs')");
  docker("run", "--detach", "--rm", "--network", `container:${app}`, "--name", ingress,
    "--user", "1000:1000", "--env", "EVE_UPSTREAM=127.0.0.1:4274", "--env", "NEXT_UPSTREAM=127.0.0.1:3000",
    caddyImage);

  const mapped = docker("port", app, "8080/tcp");
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
  for (const [name, value] of Object.entries({
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "x-frame-options": "DENY", "permissions-policy": "camera=(), geolocation=(), microphone=()",
    "content-security-policy": "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
    "cache-control": "no-store",
  })) assert.equal(health.headers.get(name), value, `Eve response missing ${name}`);

  const callback = await fetch(`${origin}/.well-known/workflow/v1/flow?probe=callback`, {
    method: "POST", body: "workflow-body", headers: {
      authorization: "Bearer probe-only-token", cookie: "probe_session=opaque",
    }, signal: AbortSignal.timeout(5_000),
  });
  assert.equal(callback.status, 200);
  assert.deepEqual(await callback.json(), { body: "workflow-body", query: "callback",
    authorizationForwarded: true, cookieForwarded: true });
  assert.equal(callback.headers.get("cache-control"), "no-store");
  assert.equal(callback.headers.get("x-content-type-options"), "nosniff");
  const page = await fetch(`${origin}/records?probe=next`);
  assert.equal(page.status, 200);
  assert.deepEqual(await page.json(), { next: true, path: "/records?probe=next" });
  assert.equal(page.headers.get("content-security-policy"), "script-src 'nonce-next-fixture'",
    "the ingress must preserve Next's request-specific CSP");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  const api = await fetch(`${origin}/api/v1/records`);
  assert.deepEqual(await api.json(), { next: true, path: "/api/v1/records" });

  const stream = await fetch(`${origin}/eve/v1/session/probe/stream`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/);
  assert.equal(stream.headers.get("cache-control"), "no-store");
  assert.equal(stream.headers.get("x-content-type-options"), "nosniff");
  const reader = stream.body.getReader();
  const first = await reader.read(), firstAt = Date.now();
  assert.equal(new TextDecoder().decode(first.value), "data: first\n\n");
  const second = await reader.read(), secondAt = Date.now();
  assert.equal(new TextDecoder().decode(second.value), "data: second\n\n");
  assert.ok(secondAt - firstAt >= 250, "the ingress must stream before Eve finishes");
  await reader.cancel();
  console.log("Split ingress passed: Next/Eve routes, Workflow callback, security headers and live SSE.");
} finally {
  cleanup("rm", "--force", ingress);
  cleanup("rm", "--force", app);
  cleanup("image", "rm", caddyImage);
}
