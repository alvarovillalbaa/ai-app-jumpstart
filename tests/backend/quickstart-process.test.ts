import { expect, it } from "vitest";
import { once } from "node:events";
import { processManager } from "../../scripts/helpers/quickstart-process.mjs";

it("redacts known secrets and suppresses not-yet-parsed credential output on command failure", async () => {
  const manager = processManager({ cwd: process.cwd(), env: { PATH: process.env.PATH }, secrets: ["private-credential"] });
  try {
    await expect(manager.command(process.execPath, ["-e", 'console.error("private-credential"); process.exitCode=1']))
      .rejects.toThrow("[redacted]");
    const error = await manager.command(process.execPath, ["-e", 'console.log("unknown-private-credential"); process.exitCode=1'], { privateOutput: true }).catch((failure: Error) => failure);
    expect(String(error)).not.toContain("unknown-private-credential");
  } finally { await manager.stopAll(); }
});

it("refuses oversized stdout and terminates a command that stays alive", async () => {
  const manager = processManager({ cwd: process.cwd(), env: {} });
  try {
    await expect(manager.command(process.execPath, ["-e", 'process.stdout.write("x".repeat(2*1024*1024)); setInterval(()=>{},1000)']))
      .rejects.toThrow("oversized output");
  } finally { await manager.stopAll(); }
});

it("stops an owned descendant listener when its parent's deadline expires", async () => {
  const manager = processManager({ cwd: process.cwd(), env: {} });
  const listener = 'require("node:http").createServer((q,s)=>s.end("ready")).listen(0,"127.0.0.1",function(){ console.log(this.address().port) })';
  const parent = `const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(listener)}],{stdio:["ignore","pipe","inherit"]}); child.stdout.pipe(process.stdout); setInterval(()=>{},1000)`;
  const owned = manager.launch(process.execPath, ["-e", parent], { timeout: 1500 });
  const failure = owned.result().catch((error: Error) => error);
  try {
    const [chunk] = await once(owned.child.stdout, "data");
    const origin = `http://127.0.0.1:${Number(String(chunk).trim())}`;
    expect((await fetch(origin, { signal: AbortSignal.timeout(1000) })).status).toBe(200);
    expect(String(await failure)).toContain("process error");
    expect(await fetch(origin, { signal: AbortSignal.timeout(1000) }).catch(() => null)).toBeNull();
  } finally { await manager.stopAll(); }
});
