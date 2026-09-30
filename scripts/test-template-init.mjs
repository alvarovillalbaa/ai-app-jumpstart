import assert from "node:assert/strict";
import { mkdir,mkdtemp,readFile,rm,symlink,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./init-template.mjs", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "jumpstart-template-init-"));
const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: "utf8" });
const readJson = async path => JSON.parse(await readFile(join(directory, path), "utf8"));

try {
  await mkdir(join(directory, "supabase"));
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ name: "ai-app-jumpstart", version: "0.1.0", scripts: {} }, null, 2)}\n`);
  await writeFile(join(directory, "package-lock.json"), `${JSON.stringify({ name: "ai-app-jumpstart", lockfileVersion: 3, packages: { "": { name: "ai-app-jumpstart", version: "0.1.0" } } }, null, 2)}\n`);
  await writeFile(join(directory, "app.config.ts"), 'export const appConfig = {\n  id: "ai-app-jumpstart",\n  name: "AI App Jumpstart",\n} as const;\n');
  await writeFile(join(directory, "supabase/config.toml"), 'project_id = "ai-app-jumpstart"\n');
  await writeFile(join(directory, "README.md"), "# AI App Jumpstart\n\nStable documentation stays in place.\n");

  const preview = run("--name", 'Acme "Cloud" Assistant');
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Preview only/);
  assert.equal((await readJson("package.json")).name, "ai-app-jumpstart", "preview must not write files");

  const invalid = run("--name", "Acme Assistant", "--slug", "../shared", "--apply");
  assert.equal(invalid.status, 2);
  assert.equal((await readJson("package.json")).name, "ai-app-jumpstart", "invalid input must not write files");

  const applied = run("--name", 'Acme "Cloud" Assistant', "--apply");
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal((await readJson("package.json")).name, "acme-cloud-assistant");
  const lock = await readJson("package-lock.json");
  assert.equal(lock.name, "acme-cloud-assistant");
  assert.equal(lock.packages[""].name, "acme-cloud-assistant");
  assert.match(await readFile(join(directory, "app.config.ts"), "utf8"), /id: "acme-cloud-assistant"/);
  assert.match(await readFile(join(directory, "app.config.ts"), "utf8"), /name: "Acme \\\"Cloud\\\" Assistant"/);
  assert.match(await readFile(join(directory, "supabase/config.toml"), "utf8"), /project_id = "acme-cloud-assistant"/);
  assert.match(await readFile(join(directory, "README.md"), "utf8"), /^# Acme "Cloud" Assistant/m);

  const repeat = run("--name", 'Acme "Cloud" Assistant', "--apply");
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.match(repeat.stdout, /already initialized/);

  const privateFile = join(directory,"private-input.txt"),readme = join(directory,"README.md");
  await writeFile(privateFile,"private target remains untouched\n");
  await rm(readme);
  await symlink(privateFile,readme);
  const symlinked = run("--name","Changed Name","--apply");
  assert.equal(symlinked.status,1);
  assert.equal(await readFile(privateFile,"utf8"),"private target remains untouched\n");
  console.log("Template initializer passed preview, validation, identity/lockfile synchronization, escaped display names, idempotent rerun and symlink refusal checks.");
} catch (error) {
  console.error(`Template initializer contract failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
