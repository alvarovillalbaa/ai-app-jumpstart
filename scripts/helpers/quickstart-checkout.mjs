import assert from "node:assert/strict";
import { readFile,stat,writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Only committed source and a fresh pinned install may enter onboarding proof. */
export async function cloneCommittedCheckout({ root,directory,env,command,phase }) {
  const revision = await command("git",["rev-parse","HEAD"]);
  assert.match(revision,/^[a-f0-9]{40}$/);
  const checkout = join(directory,"checkout");
  phase("clean clone");
  const npmConfig = join(directory,"empty-npm-config");
  const npmGlobalConfig = join(directory,"empty-npm-global-config");
  await writeFile(npmConfig,"",{ mode: 0o600,flag: "wx" });
  await writeFile(npmGlobalConfig,"",{ mode: 0o600,flag: "wx" });
  Object.assign(env,{ npm_config_userconfig: npmConfig,npm_config_globalconfig: npmGlobalConfig,npm_config_cache: join(directory,"npm-cache") });
  await command("git",["clone","--quiet","--no-local","--no-checkout","--",root,checkout]);
  await command("git",["checkout","--quiet","--detach",revision],{ cwd: checkout });
  assert.equal(await command("git",["status","--porcelain"],{ cwd: checkout }),"");
  for (const path of [".env.local",".env","node_modules",".next",".output",".eve",".data",".vercel",".open-next",".amplify-build","cdk.out"]) {
    assert.equal(await stat(join(checkout,path)).then(() => true,failure => {
      if (failure.code === "ENOENT") return false;throw failure;
    }),false,`Fresh clone unexpectedly contains ${path}`);
  }
  phase("pinned install");
  const lockBefore = await readFile(join(checkout,"package-lock.json"));
  await command("npm",["ci"],{ cwd: checkout,timeout: 600_000 });
  assert.deepEqual(await readFile(join(checkout,"package-lock.json")),lockBefore);
  return { checkout,revision };
}
