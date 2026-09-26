import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { backupPostgresApplication, backupPostgresWorkflow, libpqEnvironment } from "./backup-postgres.mjs";
import { checkSnapshotUploadCatalog, copyUploadSnapshot, describeUploadSnapshot, privateUploadDirectory, snapshotObjectName } from "./private-upload-snapshot.mjs";

const format = "jumpstart-postgres-databases";
const archiveNames = ["application.dump", "workflow.dump"];
const manifestName = "manifest.json";
function fail(message) { throw new Error(`PostgreSQL database set: ${message}`); }
function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

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
  const marker = join(root, manifestName), markerDetails = await lstat(marker);
  if (!markerDetails.isFile() || markerDetails.isSymbolicLink() ||
      (markerDetails.mode & 0o077) !== 0 || markerDetails.size > 20_000_000)
    fail("manifest is missing or not private.");
  let manifest;
  try { manifest = JSON.parse(await readFile(marker, "utf8")); }
  catch { fail("manifest JSON is invalid."); }
  if (!manifest || manifest.format !== format || ![1, 2].includes(manifest.version) ||
      typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt)) ||
      typeof manifest.restoreVerified !== "boolean" || !Array.isArray(manifest.files) ||
      manifest.files.length < archiveNames.length || manifest.files.length > 100_002 ||
      manifest.version === 1 && manifest.files.length !== archiveNames.length ||
      manifest.version === 2 && !["included", "excluded"].includes(manifest.uploads))
    fail("manifest is invalid or incomplete.");
  const included = manifest.version === 2 && manifest.uploads === "included";
  const expected = [...archiveNames, manifestName, ...(included ? ["uploads"] : [])].sort();
  if (JSON.stringify(entries) !== JSON.stringify(expected)) fail("snapshot has missing or unexpected files.");
  for (const [index, row] of manifest.files.entries()) {
    if (!row || typeof row !== "object" ||
        (index < 2 ? row.name !== archiveNames[index] : !included || !snapshotObjectName.test(row.name)) ||
        !Number.isSafeInteger(row.bytes) || row.bytes < 0 ||
        typeof row.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(row.sha256))
      fail("manifest has an invalid file entry.");
  }
  const actual = await Promise.all(archiveNames.map(name => describeArchive(root, name)));
  if (included) actual.push(...await describeUploadSnapshot(join(root, "uploads")));
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files))
    fail("archive hashes or sizes differ from the manifest.");
  return { files: actual.length, bytes: actual.reduce((sum, row) => sum + row.bytes, 0),
    restoreVerified: manifest.restoreVerified,
    uploads: manifest.version === 1 ? "untracked" : manifest.uploads,
    uploadFiles: actual.length - archiveNames.length };
}

/** Archive two distinct PostgreSQL databases after all application and Eve writers stop.
 * @param {{ applicationUrl?: string, workflowUrl?: string, output: string,
 *   applicationRestoreUrl?: string, workflowRestoreUrl?: string, stopped?: boolean,
 *   uploadsDir?: string, env?: Record<string, string | undefined> }} options
 */
export async function createPostgresDatabaseSet({ applicationUrl, workflowUrl, output,
  applicationRestoreUrl, workflowRestoreUrl, stopped = false, uploadsDir, env = process.env }) {
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
  if (env.UPLOAD_STORAGE_PROVIDER === "local" && !uploadsDir)
    fail("configured local upload bytes must be included with --uploads-dir.");
  if (uploadsDir && env.UPLOAD_STORAGE_PROVIDER && env.UPLOAD_STORAGE_PROVIDER !== "local")
    fail("remote object storage cannot be captured as local uploads.");
  if (uploadsDir) await privateUploadDirectory(resolve(uploadsDir));
  const uploads = uploadsDir ? await realpath(uploadsDir) : null;
  if (uploads && env.UPLOAD_LOCAL_ROOT && uploads !== await realpath(env.UPLOAD_LOCAL_ROOT))
    fail("upload source does not match UPLOAD_LOCAL_ROOT.");
  const destination = join(await realpath(dirname(resolve(output))), basename(output));
  if (uploads && (inside(uploads, destination) || inside(destination, uploads)))
    fail("upload source and snapshot destination must be separate.");
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
    if (uploads) {
      await copyUploadSnapshot(uploads, join(destination, "uploads"));
      const objects = await describeUploadSnapshot(join(destination, "uploads"));
      // A rehearsed set checks the actual restored catalog, not a later source read.
      await checkSnapshotUploadCatalog(applicationRestoreUrl || applicationUrl, objects);
      if (JSON.stringify(objects) !== JSON.stringify(await describeUploadSnapshot(uploads)))
        fail("upload source changed while backing up; stop every writer.");
      files.push(...objects);
    }
    const manifest = { format, version: 2, createdAt: new Date().toISOString(),
      restoreVerified: rehearse, uploads: uploads ? "included" : "excluded", files };
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

/** Install captured local bytes into a NEW private object root, never a live mount. */
export async function restorePostgresUploadSnapshot(source, output) {
  if (!output) fail("provide a new upload restore directory.");
  await privateUploadDirectory(resolve(source));
  const root = await realpath(source), verified = await verifyPostgresDatabaseSet(root);
  if (verified.uploads !== "included") fail("this database set does not include local upload bytes.");
  const destination = join(await realpath(dirname(resolve(output))), basename(output));
  if (inside(root, destination) || inside(destination, root)) fail("restore destination must be separate from the snapshot.");
  await copyUploadSnapshot(join(root, "uploads"), destination);
  let complete = false;
  try {
    if (JSON.stringify(await describeUploadSnapshot(destination)) !==
        JSON.stringify(await describeUploadSnapshot(join(root, "uploads"))))
      fail("restored upload bytes differ from the snapshot.");
    // Detect a modified source manifest/archive/object before reporting success.
    await verifyPostgresDatabaseSet(root);
    complete = true;
    return { output: destination, uploadFiles: verified.uploadFiles };
  } finally { if (!complete) await rm(destination, { recursive: true, force: true }); }
}

async function main(args) {
  if (args.length === 2 && args[0] === "--verify") {
    const result = await verifyPostgresDatabaseSet(args[1]);
    console.log(`Private PostgreSQL database set verified: ${result.files} files, ${result.bytes} bytes; uploads ${result.uploads} (${result.uploadFiles} objects). ${result.restoreVerified ? "Disposable database restores passed at creation." : "Restore not rehearsed."}`);
    return;
  }
  if (args.length === 4 && args[0] === "--restore-uploads" && args[2] === "--output") {
    const result = await restorePostgresUploadSnapshot(args[1], args[3]);
    console.log(`Restored ${result.uploadFiles} private upload objects to a new directory: ${result.output}.`);
    return;
  }
  const usage = "usage: npm run backup:postgres-databases -- --create --output NEW_DIR --stopped [--verify-restore] [--uploads-dir PRIVATE_ROOT] | --verify DIR | --restore-uploads DIR --output NEW_ROOT";
  if (args[0] !== "--create") fail(usage);
  const options = new Map();
  for (let index = 1; index < args.length; index++) {
    const key = args[index];
    if (options.has(key) || !["--output", "--stopped", "--verify-restore", "--uploads-dir"].includes(key)) fail(usage);
    if (["--stopped", "--verify-restore"].includes(key)) options.set(key, true);
    else {
      const value = args[++index];
      if (!value || value.startsWith("--")) fail(usage);
      options.set(key, value);
    }
  }
  if (!options.get("--output") || !options.get("--stopped")) fail(usage);
  const rehearse = Boolean(options.get("--verify-restore"));
  if (rehearse && (!process.env.BACKUP_VERIFY_APP_DATABASE_URL || !process.env.BACKUP_VERIFY_WORKFLOW_DATABASE_URL))
    fail("set both BACKUP_VERIFY_APP_DATABASE_URL and BACKUP_VERIFY_WORKFLOW_DATABASE_URL to empty loopback databases.");
  const result = await createPostgresDatabaseSet({ applicationUrl: process.env.DATABASE_URL,
    workflowUrl: process.env.WORKFLOW_POSTGRES_URL, output: options.get("--output"), stopped: true,
    uploadsDir: options.get("--uploads-dir"),
    applicationRestoreUrl: rehearse ? process.env.BACKUP_VERIFY_APP_DATABASE_URL : undefined,
    workflowRestoreUrl: rehearse ? process.env.BACKUP_VERIFY_WORKFLOW_DATABASE_URL : undefined });
  console.log(`Private PostgreSQL database set: ${result.output} (${result.files} files, ${result.bytes} bytes; uploads ${result.uploads}, ${result.uploadFiles} objects). ${result.restoreVerified ? "Disposable database restores passed." : "Restore not rehearsed."}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error && /^(PostgreSQL database set|Private upload snapshot):/.test(error.message)
      ? error.message : "PostgreSQL database set failed; inspect source and restore databases, privileges and client tools.");
    process.exitCode = 1;
  });
