import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

/** Real compiled Eve with a deterministic model and the production auth/hooks. */
export async function startChatFixture(root, directory, applicationEnv, { buildOnly = false, routesManifest } = {}) {
  const source = join(root, "tests/fixtures/eve-access"), fixture = join(directory, "eve-app");
  const manifest = routesManifest ?? JSON.parse(await readFile(join(root, ".next/routes-manifest.json"), "utf8"));
  const rewrite = manifest.rewrites.beforeFiles.find(item => item.source === "/eve/v1/:path+");
  const origin = new URL(rewrite.destination).origin;
  if (new URL(origin).hostname !== "127.0.0.1") throw new Error("Chat tests require the local production Eve rewrite.");
  const port = Number(new URL(origin).port);
  // Refuse to reuse or stop another process listening on the compiled target.
  const socket = createServer(); socket.listen(port, "127.0.0.1"); await once(socket, "listening");
  await new Promise(resolve => socket.close(resolve));
  await cp(join(source, "agent"), join(fixture, "agent"), { recursive: true });
  const pkg = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
  await writeFile(join(fixture, "package.json"), JSON.stringify({ ...pkg, name: `jumpstart-chat-${randomBytes(8).toString("hex")}` }));
  await symlink(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
  async function relocate(relative) {
    for (const entry of await readdir(join(fixture, relative), { withFileTypes: true })) {
      const child = join(relative, entry.name);
      if (entry.isDirectory()) await relocate(child);
      else if (entry.name.endsWith(".ts")) {
        const content = await readFile(join(fixture, child), "utf8");
        await writeFile(join(fixture, child), content.replace(/from "(\.\.?\/[^\"]+)"/g, (_match, specifier) => `from ${JSON.stringify(resolve(dirname(join(source, child)), specifier))}`));
      }
    }
  }
  await relocate("agent");
  await writeFile(join(fixture, "agent/channels/eve.ts"), `export { default } from ${JSON.stringify(join(root, "agent/channels/eve.ts"))};\n`);
  const gate = join(directory, "gate"); await writeFile(gate, "ready");
  const env = { ...applicationEnv, EVE_DEV: "", EVE_TELEMETRY_DISABLED: "1", EVE_WORKFLOW_PROVIDER: "default", NITRO_PRESET: "node-server",
    HOST: "127.0.0.1", NITRO_HOST: "127.0.0.1", PORT: String(port), NITRO_PORT: String(port),
    WORKFLOW_TARGET_WORLD: "local", WORKFLOW_LOCAL_DATA_DIR: join(directory, "workflow"), WORKFLOW_LOCAL_BASE_URL: origin,
    TEST_MODEL_RECEIPTS: join(directory, "models.txt"), TEST_FAILURE_RECEIPTS: join(directory, "failures.txt"), TEST_RECEIPT_GATE: gate,
    AI_RUNTIME_ORIGIN: origin,
  };
  for (const key of ["VERCEL", "VERCEL_ENV", "VERCEL_TARGET_ENV", "VERCEL_OIDC_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY"]) delete env[key];
  let child, output = "";
  function start(command, args) {
    child = spawn(command, args, { cwd: fixture, env, stdio: ["ignore", "pipe", "pipe"] });
    const capture = chunk => { output = (output + chunk).slice(-10000); };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
  }
  async function stop() {
    if (child?.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit"); child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000); await exited; clearTimeout(timer);
    }
  }
  try {
    start(join(root, "node_modules/.bin/eve"), ["build"]);
    const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
    const [code] = await once(child, "exit"); clearTimeout(timer);
    if (code !== 0) throw new Error("Chat fixture compilation failed.");
    if (buildOnly) return { origin, output: join(fixture, ".output"), stop };
    start(process.execPath, [join(fixture, ".output/server/index.mjs")]);
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      if ((await fetch(`${origin}/eve/v1/health`, { signal: AbortSignal.timeout(1000) }).catch(() => null))?.ok) return { origin, stop };
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("Chat fixture did not start.");
  } catch (error) {
    await stop();
    // Runtime diagnostics may contain tokens or prompts; keep them out of CI.
    if (output.includes("ERROR") && !output.includes("Listening")) console.error("Eve fixture reported an error during compilation/startup.");
    throw error;
  }
}
