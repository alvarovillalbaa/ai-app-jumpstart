import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function targetOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Set APP_API_URL to an HTTP(S) origin."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_API_URL must be an HTTP(S) origin without credentials, path, query or fragment.");
  }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Use HTTPS for a remote deployment.");
  }
  return url.origin;
}

function message(error) { return error instanceof Error ? error.message : "Unknown error"; }

async function cliGet(origin, token, id) {
  const executable = fileURLToPath(new URL("./app-cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", executable, "get", id], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, APP_API_URL: origin, APP_API_TOKEN: token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout = (stdout + chunk).slice(-100_000); });
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-1000); });
  const [code, signal] = await once(child, "exit");
  if (code !== 0 || signal) throw new Error(`CLI record read failed (${signal ?? code}): ${stderr.replaceAll(token, "[redacted]")}`);
  return JSON.parse(stdout);
}

export async function runHostedSmoke({ url, token, otherToken, accounts = false }) {
  const origin = targetOrigin(url);
  if (!token || !otherToken || token === otherToken) throw new Error("Set distinct APP_API_TOKEN and APP_API_OTHER_TOKEN with record read/write access for different owners.");
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const protection = bypass ? { "x-vercel-protection-bypass": bypass } : {};
  const authorized = { authorization: `Bearer ${token}` };
  const other = { authorization: `Bearer ${otherToken}` };
  const request = (path, options = {}) => {
    const { headers, ...rest } = options;
    return fetch(new URL(path, origin), {
      redirect: "error", signal: AbortSignal.timeout(15_000), ...rest,
      headers: { ...protection, ...headers },
    });
  };
  const live = await request("/api/health/live");
  assert.equal(live.status, 200, "Web liveness failed");
  const ready = await request("/api/health/ready");
  assert.equal(ready.status, 200, "Application data readiness failed");
  const checks = await ready.json();
  assert.equal(checks.status, "ready");
  assert.equal(checks.checks?.data, "ok");
  const agent = await request("/eve/v1/health");
  assert.equal(agent.status, 200, "Eve health failed");
  assert.equal((await agent.json()).status, "ready");
  const page = await request("/records");
  assert.equal(page.status, 200, "Records page failed");
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal((await request("/api/v1/records")).status, 401, "Anonymous record access must be denied");
  if (accounts) {
    // Usage is a registered-user-only route. This proves the deployment accepts
    // both Supabase identities and has account chat configured without a model call.
    for (const headers of [authorized, other]) {
      const usage = await request("/api/v1/usage", { headers });
      assert.equal(usage.status, 200, "Supabase account usage access failed");
      assert.ok((await usage.json()).dailyLimitMicros > 0, "Account budget policy is unavailable");
    }
  }

  const title = `Hosted smoke ${randomUUID()}`;
  console.log(`Temporary record: ${title}`);
  let record, client, failure, cleanupFailure;
  try {
    const created = await request("/api/v1/records", {
      method: "POST", headers: { ...authorized, "content-type": "application/json" },
      body: JSON.stringify({ title, content: "Portable REST, CLI and MCP acceptance check." }),
    });
    assert.equal(created.status, 201, "Record creation failed");
    record = await created.json();
    assert.equal(record.title, title);
    assert.match(record.id, /^[0-9a-f-]{36}$/i);
    const ownRead = await request(`/api/v1/records/${record.id}`, { headers: authorized });
    assert.equal(ownRead.status, 200);
    assert.deepEqual(await ownRead.json(), record);
    assert.equal((await request(`/api/v1/records/${record.id}`, { headers: other })).status, 404, "Other owner can read the temporary record");
    assert.equal((await request(`/api/v1/records/${record.id}`, {
      method: "PATCH", headers: { ...other, "content-type": "application/json" },
      body: JSON.stringify({ title: "Unauthorized edit", content: record.content, revision: record.revision }),
    })).status, 409, "Other owner can edit the temporary record");
    assert.equal((await request(`/api/v1/records/${record.id}?revision=${record.revision}`, {
      method: "DELETE", headers: other,
    })).status, 409, "Other owner can delete the temporary record");
    const otherList = await request("/api/v1/records?limit=100", { headers: other });
    assert.equal(otherList.status, 200, "Other owner's record list failed");
    assert.ok(!(await otherList.json()).items.some(item => item.id === record.id), "Other owner can list the temporary record");
    assert.deepEqual(await cliGet(origin, token, record.id), record);
    client = new Client({ name: "hosted-smoke", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), { requestInit: { headers: { ...protection, ...authorized } } }));
    const resource = await client.readResource({ uri: `records:///${record.id}` });
    assert.deepEqual(JSON.parse(resource.contents[0].text), record);
  } catch (error) { failure = error; }
  finally {
    try { await client?.close(); } catch (error) { cleanupFailure = error; }
    if (record) {
      try {
        const deleted = await request(`/api/v1/records/${record.id}?revision=${record.revision}`, { method: "DELETE", headers: authorized });
        assert.equal(deleted.status, 204, "Temporary record cleanup failed");
      } catch (error) { cleanupFailure = error; }
    }
  }
  if (failure && cleanupFailure) throw new Error(`${message(failure)}; cleanup: ${message(cleanupFailure)}`);
  if (failure) throw failure;
  if (cleanupFailure) throw cleanupFailure;
  return { origin, recordId: record.id };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args[0] && args[0] !== "--accounts")) {
    console.error("Supported option: --accounts.");
    process.exitCode = 2;
  } else {
    const accounts = args[0] === "--accounts";
    runHostedSmoke({ url: process.env.APP_API_URL, token: process.env.APP_API_TOKEN, otherToken: process.env.APP_API_OTHER_TOKEN, accounts })
      .then(({ origin }) => console.log(`Hosted smoke passed for ${origin}: readiness, Eve, web, ${accounts ? "Supabase accounts, " : ""}REST, owner isolation, CLI and MCP.`))
      .catch(error => { console.error(message(error)); process.exitCode = 1; });
  }
}
