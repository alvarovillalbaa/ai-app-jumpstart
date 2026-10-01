import { open, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { cleanupJob } from "../lib/deploy/cleanup-job";
import type { CloudProvider } from "../lib/deploy/cloud-config";

const usage = "Usage: npm run cloud:cleanup-job -- --provider aws|azure|gcp --file RUNTIME.json --name JOB --output NEW.json";
async function main(args: string[]) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--provider", "--file", "--name", "--output"].includes(key) ||
        options.has(key) || !value || value.startsWith("--")) throw new Error(usage);
    options.set(key, value);
  }
  if (!["aws", "azure", "gcp"].includes(options.get("--provider") ?? "") ||
      ["--file", "--name", "--output"].some(key => !options.has(key))) throw new Error(usage);
  let source: unknown;
  try { source = JSON.parse(await readFile(resolve(options.get("--file")!), "utf8")); }
  catch { throw new Error("Could not read a selected JSON runtime manifest."); }
  const job = cleanupJob(options.get("--provider") as CloudProvider, source, options.get("--name")!);
  const path = resolve(options.get("--output")!);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch { throw new Error("Could not create output; choose a new file in an existing private directory."); }
  try { await handle.writeFile(JSON.stringify(job, null, 2) + "\n"); }
  catch { await handle.close(); await rm(path, { force: true }); throw new Error("Could not write the cleanup job."); }
  await handle.close();
  console.log("Cleanup job written. Review its identity, secret access, schedule, egress and live result before release.");
}
main(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.message : "Cleanup job generation failed.");
  process.exitCode = 1;
});
