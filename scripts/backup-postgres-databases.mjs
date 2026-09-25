import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { backupPostgresApplication, backupPostgresWorkflow, libpqEnvironment } from "./backup-postgres.mjs";

const format = "jumpstart-postgres-databases";
const archiveNames = ["application.dump", "workflow.dump"];
const manifestName = "manifest.json";
function fail(message) { throw new Error(`PostgreSQL database set: ${message}`); }

async function digest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function describeArchive(root, name) {
  const path = join(root, name), details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink() || (details.mode & 0o077) !== 0 || details.size === 0)
    fail("an archive is missing or not a private regular file.");
  return { name, bytes: details.size, sha256: await digest(path) };
}

/** Verify the database pair without contacting either source database. */
export async function verifyPostgresDatabaseSet(directory) {
  const root = resolve(directory), details = await lstat(root);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
    fail("expected a private, real snapshot directory.");
  const entries = (await readdir(root)).sort();
  if (JSON.stringify(entries) !== JSON.stringify([...archiveNames, manifestName].sort()))
    fail("snapshot has missing or unexpected files.");
  const marker = join(root, manifestName), markerDetails = await lstat(marker);
  if (!markerDetails.isFile() || markerDetails.isSymbolicLink() ||
      (markerDetails.mode & 0o077) !== 0 || markerDetails.size > 100_000)
    fail("manifest is missing or not private.");
  let manifest;
  try { manifest = JSON.parse(await readFile(marker, "utf8")); }
  catch { fail("manifest JSON is invalid."); }
  if (!manifest || manifest.format !== format || manifest.version !== 1 ||
      typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      typeof manifest.restoreVerified !== "boolean" || !Array.isArray(manifest.files) ||
      manifest.files.length !== archiveNames.length)
    fail("manifest is invalid or incomplete.");
  const actual = await Promise.all(archiveNames.map(name => describeArchive(root, name)));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    fail("archive hashes or sizes differ from the manifest.");
  return { files: actual.length, bytes: actual.reduce((sum, row) => sum + row.bytes, 0),
    restoreVerified: manifest.restoreVerified };
}

/** Archive two distinct PostgreSQL databases after all application and Eve writers stop.
 * @param {{ applicationUrl?: string, workflowUrl?: string, output: string,
 *   applicationRestoreUrl?: string, workflowRestoreUrl?: string, stopped?: boolean }} options
 */
export async function createPostgresDatabaseSet({ applicationUrl, workflowUrl, output,
  applicationRestoreUrl, workflowRestoreUrl, stopped = false }) {
  if (!stopped) fail("stop all application and Eve writers and pass --stopped.");
  if (!applicationUrl || !workflowUrl) fail("set DATABASE_URL and WORKFLOW_POSTGRES_URL.");
  if (!output) fail("provide a new output directory.");
  const application = libpqEnvironment(applicationUrl), workflow = libpqEnvironment(workflowUrl);
  if (application.host === workflow.host && application.port === workflow.port &&
      application.database === workflow.database)
    fail("application and Workflow must use distinct databases.");
  const rehearse = Boolean(applicationRestoreUrl || workflowRestoreUrl);
  if (rehearse && (!applicationRestoreUrl || !workflowRestoreUrl))
    fail("provide both empty loopback restore database URLs.");
  const destination = join(await realpath(dirname(resolve(output))), basename(output));
  try { await mkdir(destination, { mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") fail("destination already exists; choose a new directory.");
    throw error;
  }
  let complete = false;
  try {
    await backupPostgresApplication(applicationUrl, join(destination, archiveNames[0]), applicationRestoreUrl);
    await backupPostgresWorkflow(workflowUrl, join(destination, archiveNames[1]), workflowRestoreUrl, true);
    const files = await Promise.all(archiveNames.map(name => describeArchive(destination, name)));
    const manifest = { format, version: 1, createdAt: new Date().toISOString(),
      restoreVerified: rehearse, files };
    const temporary = join(destination, ".manifest.tmp");
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await link(temporary, join(destination, manifestName));
    await unlink(temporary);
    const verified = await verifyPostgresDatabaseSet(destination);
    complete = true;
    return { output: destination, ...verified };
  } finally { if (!complete) await rm(destination, { recursive: true, force: true }); }
}

async function main(args) {
  if (args.length === 2 && args[0] === "--verify") {
    const result = await verifyPostgresDatabaseSet(args[1]);
    console.log(`Private PostgreSQL database set verified: ${result.files} archives, ${result.bytes} bytes. ${result.restoreVerified ? "Disposable restores passed at creation." : "Restore not rehearsed."}`);
    return;
  }
  if (![4, 5].includes(args.length) || args[0] !== "--create" || args[1] !== "--output" ||
      !args[2] || args[3] !== "--stopped" || args.length === 5 && args[4] !== "--verify-restore")
    fail("usage: npm run backup:postgres-databases -- --create --output NEW_DIR --stopped [--verify-restore] | --verify DIR");
  const rehearse = args.length === 5;
  if (rehearse && (!process.env.BACKUP_VERIFY_APP_DATABASE_URL || !process.env.BACKUP_VERIFY_WORKFLOW_DATABASE_URL))
    fail("set both BACKUP_VERIFY_APP_DATABASE_URL and BACKUP_VERIFY_WORKFLOW_DATABASE_URL to empty loopback databases.");
  const result = await createPostgresDatabaseSet({ applicationUrl: process.env.DATABASE_URL,
    workflowUrl: process.env.WORKFLOW_POSTGRES_URL, output: args[2], stopped: true,
    applicationRestoreUrl: rehearse ? process.env.BACKUP_VERIFY_APP_DATABASE_URL : undefined,
    workflowRestoreUrl: rehearse ? process.env.BACKUP_VERIFY_WORKFLOW_DATABASE_URL : undefined });
  console.log(`Private PostgreSQL database set: ${result.output} (${result.files} archives, ${result.bytes} bytes). ${result.restoreVerified ? "Disposable restores passed." : "Restore not rehearsed."}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error && error.message.startsWith("PostgreSQL database set:")
      ? error.message : "PostgreSQL database set failed; inspect source and restore databases, privileges and client tools.");
    process.exitCode = 1;
  });
