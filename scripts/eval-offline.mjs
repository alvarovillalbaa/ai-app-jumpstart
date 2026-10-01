import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../tests/fixtures/eve/", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/.bin/eve", import.meta.url));
const receiptDirectory = await mkdtemp(join(tmpdir(), "jumpstart-ai-eval-"));
const receipts = join(receiptDirectory, "side-effects.jsonl");
try {
  await writeFile(receipts, "", { mode: 0o600 });
  const child = spawn(cli, ["eval", "--strict", "--junit", ".eve/junit.xml"], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "development", EVE_EVAL_SIDE_EFFECT_RECEIPTS: receipts },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  const result = await new Promise(resolve => {
    child.once("error", error => { console.error(error.message);resolve({ code: 1 }); });
    child.once("exit", (code, signal) => resolve({ code: signal ? 1 : code ?? 1 }));
  });
  process.exitCode = result.code;
  if (result.code === 0) {
    const lines = (await readFile(receipts, "utf8")).trim().split("\n").filter(Boolean);
    assert.deepEqual(lines.map(line => JSON.parse(line)), [
      { title: "Approved release",content: "Publish this exact draft." },
    ], "Only the explicitly approved fixture action may write a side-effect receipt.");
    console.log("Approval side-effect contract passed: one approved action, zero cancelled actions.");
  }
} finally {
  await rm(receiptDirectory, { recursive: true,force: true });
}
