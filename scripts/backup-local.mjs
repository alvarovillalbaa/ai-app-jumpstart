import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rm, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { backupSqliteApplication } from "./backup-sqlite.mjs";
import { DatabaseSync } from "node:sqlite";

const manifestName = "manifest.json";
const format = "jumpstart-local-snapshot";
const shaPattern = /^[a-f0-9]{64}$/;
function fail(message) { throw new Error(`Local snapshot: ${message}`); }
function inside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
async function privateDirectory(path,requirePrivate = false) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || (requirePrivate && (details.mode & 0o077) !== 0))
    fail("expected a private, real directory.");
}
async function copyTree(source, target) {
  await privateDirectory(source);
  await mkdir(target, { mode: 0o700 });
  for (const name of await readdir(source)) {
    const from = join(source,name),to = join(target,name),details = await lstat(from);
    if (details.isSymbolicLink()) fail("symlinks are not supported in local snapshot data.");
    if (details.isDirectory()) await copyTree(from,to);
    else if (details.isFile()) {
      await copyFile(from,to);
      await chmod(to,0o600);
    } else fail("local snapshot data contains a non-file entry.");
  }
}
async function filesUnder(root,prefix = "") {
  const files = [];
  for (const name of await readdir(join(root,prefix))) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (path === manifestName) continue;
    const details = await lstat(join(root,path));
    if (details.isSymbolicLink()) fail("snapshot contains a symlink.");
    if (details.isDirectory()) {
      await privateDirectory(join(root,path),true);
      files.push(...await filesUnder(root,path));
    }
    else if (details.isFile()) files.push(path);
    else fail("snapshot contains a non-file entry.");
  }
  return files.sort();
}
async function fileDigest(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function describeFiles(root) {
  const files = [];
  for (const path of await filesUnder(root)) {
    const details = await lstat(join(root,path));
    if ((details.mode & 0o077) !== 0) fail("snapshot contains a file readable by other users.");
    files.push({ path,bytes: details.size,sha256: await fileDigest(join(root,path)) });
  }
  return files;
}
function validFile(row) {
  if (!row || typeof row !== "object" || typeof row.path !== "string" ||
      !(row.path === "app.sqlite" || row.path.startsWith("workflow/") || row.path.startsWith("uploads/")) ||
      row.path.split("/").some(part => !part || part === "." || part === "..") ||
      row.path.includes("\\") || row.path.includes("\0") ||
      !Number.isSafeInteger(row.bytes) || row.bytes < 0 ||
      typeof row.sha256 !== "string" || !shaPattern.test(row.sha256))
    fail("manifest has an invalid file entry.");
}
function validateManifest(value) {
  if (!value || typeof value !== "object" || value.format !== format || value.version !== 1 ||
      !["included","disabled"].includes(value.uploads) || !Array.isArray(value.files) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)))
    fail("manifest is invalid or incomplete.");
  for (const row of value.files) validFile(row);
  const paths = value.files.map(row => row.path);
  if (paths.filter(path => path === "app.sqlite").length !== 1 ||
      !paths.some(path => path.startsWith("workflow/")) ||
      new Set(paths).size !== paths.length || paths.join("\n") !== [...paths].sort().join("\n") ||
      (value.uploads === "disabled" && paths.some(path => path.startsWith("uploads/"))))
    fail("manifest file list is incomplete or repeated.");
  return value;
}
async function checkApplicationDatabase(path) {
  const database = new DatabaseSync(path,{ readOnly: true });
  try {
    const rows = database.prepare("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0].integrity_check !== "ok" ||
        !database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_records'").get())
      fail("application SQLite integrity check failed.");
  } finally { database.close(); }
}

/** Verify a private snapshot before a restore rehearsal. No source services are contacted. */
export async function verifyLocalSnapshot(directory) {
  const root = resolve(directory);
  await privateDirectory(root,true);
  const marker = join(root,manifestName),markerDetails = await lstat(marker);
  if (!markerDetails.isFile() || markerDetails.isSymbolicLink() || markerDetails.size > 10_000_000 ||
      (markerDetails.mode & 0o077) !== 0) fail("manifest is missing or not private.");
  let manifest;
  try { manifest = validateManifest(JSON.parse(await readFile(marker,"utf8"))); }
  catch (error) { if (error instanceof SyntaxError) fail("manifest JSON is invalid.");throw error; }
  const actual = await describeFiles(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) fail("snapshot files do not match the manifest.");
  await privateDirectory(join(root,"workflow"),true);
  if (manifest.uploads === "included") await privateDirectory(join(root,"uploads"),true);
  else if (await lstat(join(root,"uploads")).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) fail("snapshot contains an unexpected uploads directory.");
  await checkApplicationDatabase(join(root,"app.sqlite"));
  return { files: actual.length,bytes: actual.reduce((sum,row) => sum+row.bytes,0),uploads: manifest.uploads };
}

/** The operator must stop app/Eve and local upload writers before calling this. */
export async function createLocalSnapshot({ appDb,workflowDir,uploadsDir,output }) {
  if (process.env.DATA_PROVIDER && process.env.DATA_PROVIDER !== "sqlite")
    fail("this command requires SQLite application data, not a remote provider.");
  if (process.env.WORKFLOW_EXPECTED_PROVIDER === "postgres" || process.env.EVE_WORKFLOW_PROVIDER === "postgres")
    fail("this command requires the default local Workflow world.");
  const marker = await readFile(new URL("../.output/jumpstart-workflow-provider",import.meta.url),"utf8")
    .catch(error => { if (error.code === "ENOENT") return null;throw error; });
  if (marker !== null && marker.trim() !== "default")
    fail("the built Workflow world is not the default local world.");
  if (process.env.UPLOAD_STORAGE_PROVIDER === "local" && !uploadsDir)
    fail("configured local uploads must be included.");
  if (process.env.UPLOAD_STORAGE_PROVIDER && process.env.UPLOAD_STORAGE_PROVIDER !== "local" && uploadsDir)
    fail("configured remote uploads cannot be included as local objects.");
  const app = await realpath(appDb),workflow = await realpath(workflowDir);
  const uploads = uploadsDir ? await realpath(uploadsDir) : null;
  if (process.env.SQLITE_PATH && app !== await realpath(process.env.SQLITE_PATH))
    fail("application database path does not match SQLITE_PATH.");
  if (process.env.UPLOAD_STORAGE_PROVIDER === "local" && process.env.UPLOAD_LOCAL_ROOT &&
      uploads !== await realpath(process.env.UPLOAD_LOCAL_ROOT))
    fail("upload directory does not match UPLOAD_LOCAL_ROOT.");
  if (!(await lstat(app)).isFile()) fail("application SQLite source must be a regular file.");
  await privateDirectory(workflow);
  if (uploads) await privateDirectory(uploads);
  const destination = join(await realpath(dirname(resolve(output))),basename(output));
  if (inside(workflow,destination) || (uploads && inside(uploads,destination)) ||
      (uploads && (inside(workflow,uploads) || inside(uploads,workflow))) ||
      (uploads && inside(uploads,app)) || inside(workflow,app) || app === destination)
    fail("snapshot sources and destination must be separate.");
  try { await mkdir(destination,{ mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") fail("destination already exists; choose a new path.");
    throw error;
  }
  let complete = false;
  try {
    await backupSqliteApplication(app,join(destination,"app.sqlite"));
    await copyTree(workflow,join(destination,"workflow"));
    if (uploads) await copyTree(uploads,join(destination,"uploads"));
    const files = await describeFiles(destination);
    const manifest = validateManifest({ format,version: 1,createdAt: new Date().toISOString(),
      uploads: uploads ? "included" : "disabled",files });
    const temporary = join(destination,".manifest.tmp");
    const handle = await open(temporary,"wx",0o600);
    try { await handle.writeFile(`${JSON.stringify(manifest,null,2)}\n`);await handle.sync(); }
    finally { await handle.close(); }
    await link(temporary,join(destination,manifestName));
    await unlink(temporary);
    await verifyLocalSnapshot(destination);
    complete = true;
    return { output: destination,files: files.length,uploads: manifest.uploads };
  } finally { if (!complete) await rm(destination,{ recursive: true,force: true }); }
}

/** Restore only to a new directory; moving it into service mounts is an operator step. */
export async function restoreLocalSnapshot(source,output) {
  const root = await realpath(source);
  const verified = await verifyLocalSnapshot(root);
  const destination = join(await realpath(dirname(resolve(output))),basename(output));
  if (inside(root,destination)) fail("restore destination must be outside the snapshot.");
  try { await mkdir(destination,{ mode: 0o700 }); }
  catch (error) {
    if (error.code === "EEXIST") fail("restore destination already exists; choose a new path.");
    throw error;
  }
  let complete = false;
  try {
    await copyFile(join(root,"app.sqlite"),join(destination,"app.sqlite"));
    await chmod(join(destination,"app.sqlite"),0o600);
    await copyTree(join(root,"workflow"),join(destination,"workflow"));
    if (verified.uploads === "included") await copyTree(join(root,"uploads"),join(destination,"uploads"));
    await copyFile(join(root,manifestName),join(destination,manifestName));
    await chmod(join(destination,manifestName),0o600);
    await verifyLocalSnapshot(destination);
    complete = true;
    return { output: destination,...verified };
  } finally { if (!complete) await rm(destination,{ recursive: true,force: true }); }
}

async function main(args) {
  if (args[0] === "--verify" && args.length === 2) {
    const result = await verifyLocalSnapshot(args[1]);
    console.log(`Local snapshot verified: ${result.files} files, ${result.bytes} bytes; uploads ${result.uploads}.`);
    return;
  }
  if (args[0] === "--restore" && args.length === 4 && args[2] === "--output") {
    const result = await restoreLocalSnapshot(args[1],args[3]);
    console.log(`Local snapshot restored to new directory: ${result.output}.`);
    return;
  }
  if (args[0] === "--create") {
    const options = new Map();
    for (let index = 1; index < args.length;index++) {
      const key = args[index];
      if (options.has(key) || !["--app-db","--workflow-dir","--uploads-dir","--no-uploads","--output","--stopped"].includes(key)) fail("invalid create options.");
      if (key === "--no-uploads" || key === "--stopped") options.set(key,true);
      else options.set(key,args[++index]);
    }
    if (!options.get("--app-db") || !options.get("--workflow-dir") || !options.get("--output") ||
        !options.get("--stopped") || Boolean(options.get("--uploads-dir")) === Boolean(options.get("--no-uploads")))
      fail("create requires app DB, workflow directory, output, --stopped and exactly one upload choice.");
    const result = await createLocalSnapshot({ appDb: options.get("--app-db"),workflowDir: options.get("--workflow-dir"),
      uploadsDir: options.get("--uploads-dir"),output: options.get("--output") });
    console.log(`Verified local snapshot: ${result.output} (${result.files} files; uploads ${result.uploads}).`);
    return;
  }
  fail("usage: --create --app-db FILE --workflow-dir DIR (--uploads-dir DIR|--no-uploads) --output NEW_DIR --stopped | --verify DIR | --restore DIR --output NEW_DIR");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : "Local snapshot failed.");
    process.exitCode = 1;
  });
