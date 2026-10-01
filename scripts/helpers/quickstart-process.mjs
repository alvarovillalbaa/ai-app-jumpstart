import { spawn } from "node:child_process";

/** Bounded private capture and cleanup of owned POSIX process groups.
 * @param {{ cwd: string, env: Record<string, string | undefined>, secrets?: string[] }} settings
 */
export function processManager({ cwd, env, secrets = [] }) {
  const active = new Set();
  const redact = text => secrets.reduce((value, secret) => value.replaceAll(secret, "[redacted]"), String(text));
  function launch(executable, args, options = {}) {
    const child = spawn(executable, args, { cwd: options.cwd ?? cwd, env: options.env ?? env,
      detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; let bytes = 0, stderr = "", error, overflow = false;
    const closed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
    const signal = kind => {
      if (!child.pid) return;
      try { process.kill(-child.pid, kind); } catch (failure) { if (failure.code !== "ESRCH") throw failure; }
    };
    const timeout = setTimeout(() => {
      error = new Error("Command exceeded its deadline."); signal("SIGTERM");
      escalation = setTimeout(() => signal("SIGKILL"), 2000);
    }, options.timeout ?? 240_000);
    let escalation;
    child.once("error", failure => { error = failure; });
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes <= 1024 * 1024) chunks.push(chunk);
      else if (!overflow) { overflow = true; signal("SIGTERM"); escalation ??= setTimeout(() => signal("SIGKILL"), 2000); }
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-12000); });
    const managed = {
      child, closed,
      async stop() {
        signal("SIGTERM");
        const force = setTimeout(() => signal("SIGKILL"), 2000);
        try { await closed; } finally {
          // Also stop descendants that closed their stdio before the parent ended.
          signal("SIGKILL"); clearTimeout(force); clearTimeout(timeout); clearTimeout(escalation); active.delete(managed);
        }
      },
      async result() {
        const { code, signal: endedBy } = await closed;
        const stdout = Buffer.concat(chunks).toString("utf8").trim();
        await managed.stop();
        if (error || code !== 0 || endedBy || overflow) {
          // Key generation output is private even before its token can be parsed.
          const diagnostic = options.privateOutput ? "" : `\n${redact(`${stdout}\n${stderr}`).slice(-12000)}`;
          throw new Error(`${executable} failed (${error ? "process error" : endedBy ?? code}${overflow ? ", oversized output" : ""}).${diagnostic}`);
        }
        return stdout;
      },
    };
    active.add(managed); return managed;
  }
  return { launch, command: (executable, args, options) => launch(executable, args, options).result(),
      stopAll: async () => { for (const owned of [...active]) await owned.stop(); } };
}
