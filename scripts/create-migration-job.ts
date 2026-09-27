import { open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { migrationJob, type MigrationOperation } from "../lib/deploy/migration-job";
import type { CloudProvider } from "../lib/deploy/cloud-config";

const usage = "Usage: npm run cloud:migration-job -- --provider aws|azure|gcp --file RUNTIME.json --operation application-preview|application-apply|workflow-apply --name JOB --output NEW.json [--database-secret REFERENCE.json]";
async function readJson(path: string) {
  try { return JSON.parse(await readFile(resolve(path), "utf8")) as unknown; }
  catch { throw new Error("Could not read a selected JSON input file."); }
}
async function main(args: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--provider", "--file", "--operation", "--name", "--output", "--database-secret"].includes(key) ||
        options.has(key) || !value || value.startsWith("--")) throw new Error(usage);
    options.set(key, value);
  }
  if (!["aws", "azure", "gcp"].includes(options.get("--provider") ?? "") ||
      ["--file", "--operation", "--name", "--output"].some(key => !options.has(key))) throw new Error(usage);
  const manifest = migrationJob(options.get("--provider") as CloudProvider, await readJson(options.get("--file")!),
    options.get("--operation") as MigrationOperation, options.get("--name")!,
    options.has("--database-secret") ? await readJson(options.get("--database-secret")!) : undefined);
  const path = resolve(options.get("--output")!);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch { throw new Error("Could not create output; choose a new file in an existing private directory."); }
  try { await handle.writeFile(JSON.stringify(manifest, null, 2) + "\n"); }
  catch { await handle.close(); await rm(path, { force: true }); throw new Error("Could not write the migration job."); }
  await handle.close();
  console.log("Migration job written. Review identity, database privileges, network and completion before release.");
}
main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : "Migration job generation failed.");
  process.exitCode = 1;
});
