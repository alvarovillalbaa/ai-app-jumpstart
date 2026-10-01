import assert from "node:assert/strict";
import { cp,mkdtemp,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { cloneCommittedCheckout } from "./helpers/quickstart-checkout.mjs";
import { processManager } from "./helpers/quickstart-process.mjs";

// Exercise committed source as a new organization would receive it. The three
// browser modes create disposable real Auth, SMTP, PostgREST and Storage services.
const root = fileURLToPath(new URL("../",import.meta.url));
const env = Object.fromEntries(["PATH","TMPDIR","TEMP","TMP","LANG","LC_ALL","PLAYWRIGHT_BROWSERS_PATH","DOCKER_HOST"]
  .filter(key => process.env[key]).map(key => [key,process.env[key]]));
Object.assign(env,{ CI: "true",NEXT_TELEMETRY_DISABLED: "1",EVE_TELEMETRY_DISABLED: "1",NO_COLOR: "1" });
const manager = processManager({ cwd: root,env });
const command = (...args) => manager.command(...args);
let directory,checkout,stage = "preflight",interrupted = false;
function phase(name) { stage = name;console.log(`Managed quickstart: ${name}...`); }
for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,() => {
  interrupted = true;void manager.stopAll().catch(() => {});
});

try {
  if (process.argv.length !== 2) throw new Error("This command takes no arguments and tests committed HEAD.");
  if (!["linux","darwin"].includes(process.platform)) throw new Error("The process-group rehearsal requires macOS or Linux.");
  phase("Docker readiness");
  await command("docker",["info","--format","{{.ServerVersion}}"],{ timeout: 20_000 });
  directory = await mkdtemp(join(tmpdir(),"jumpstart-managed-quickstart-"));
  const cloned = await cloneCommittedCheckout({ root,directory,env,command,phase });
  checkout = cloned.checkout;
  const { revision } = cloned;
  console.log(`Rehearsing managed path from fresh commit ${revision.slice(0,7)} without hosted credentials...`);
  phase("documented managed settings");
  const example = await readFile(join(checkout,".env.example"),"utf8");
  for (const setting of ["# AUTH_PROVIDER=supabase","# SUPABASE_URL=","# SUPABASE_SECRET_KEY=","# UPLOAD_STORAGE_PROVIDER=supabase"]) {
    assert.ok(example.split("\n").some(line => line.startsWith(setting)),`Documented managed setting is missing: ${setting}`);
  }
  const scripts = JSON.parse(await readFile(join(checkout,"package.json"),"utf8")).scripts;
  for (const name of ["db:migrate","build:local","test:auth:supabase","test:chat:supabase","test:chat:uploads:supabase"])
    assert.equal(typeof scripts[name],"string",`Managed onboarding command is missing: ${name}`);
  phase("production Eve and Next build");
  await command("npm",["run","build:local"],{ cwd: checkout,timeout: 600_000 });
  for (const [name,script] of [
    ["real Auth, private Storage and account access","test:auth:supabase"],
    ["account chat, replay and ownership","test:chat:supabase"],
    ["reviewed-file chat and native reader","test:chat:uploads:supabase"],
  ]) {
    if (interrupted) throw new Error("Rehearsal interrupted.");
    phase(name);
    await command("npm",["run",script],{ cwd: checkout,timeout: 600_000 });
  }
  phase("tracked source remains unchanged");
  assert.equal(await command("git",["status","--porcelain","--untracked-files=no"],{ cwd: checkout }),"");
  console.log(`Managed quickstart passed at ${revision.slice(0,7)}: fresh pinned install/build, real Auth/PostgREST/private Storage, two-owner account/chat/reviewed-file contracts. No hosted project or paid model was used.`);
} catch (error) {
  console.error(`Managed quickstart failed during ${stage}: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
} finally {
  await manager.stopAll();
  if (process.exitCode && checkout && process.env.GITHUB_ACTIONS === "true") {
    for (const name of ["playwright-report","test-results"]) {
      try { await cp(join(checkout,name),join(root,name),{ recursive: true,force: false,errorOnExist: true }); }
      catch (error) { if (error.code !== "ENOENT") console.error(`Could not preserve managed quickstart ${name} artifact.`); }
    }
  }
  if (directory) await rm(directory,{ recursive: true,force: true });
}
