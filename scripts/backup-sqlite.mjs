import { backup, DatabaseSync } from "node:sqlite";
import { chmod, link, lstat, mkdtemp, open, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Publish one consistent application SQLite snapshot without replacing an existing file. */
export async function backupSqliteApplication(sourcePath, outputPath) {
  const source = resolve(sourcePath), output = resolve(outputPath);
  if (source === output) throw new Error("Source and backup paths must differ.");
  const sourceInfo = await stat(source).catch(() => null);
  if (!sourceInfo?.isFile()) throw new Error("Source SQLite database is missing or is not a file.");
  if (await lstat(output).then(() => true, error => {
    if (error.code === "ENOENT") return false;
    throw error;
  })) throw new Error("Backup destination already exists; choose a new path.");

  const tempDir = await mkdtemp(join(dirname(output), ".sqlite-backup-"));
  const temporary = join(tempDir, "snapshot.sqlite");
  let database;
  try {
    database = new DatabaseSync(source, { readOnly: true, timeout: 5_000 });
    const pages = await backup(database, temporary);
    // The source may use WAL. Make the isolated backup self-contained so later
    // read-only verification cannot create sidecar files beside a published copy.
    const standalone = new DatabaseSync(temporary);
    try { standalone.exec("PRAGMA journal_mode=DELETE"); }
    finally { standalone.close(); }
    await chmod(temporary, 0o600);

    const snapshot = new DatabaseSync(temporary, { readOnly: true });
    try {
      const check = snapshot.prepare("PRAGMA integrity_check").all();
      if (check.length !== 1 || check[0].integrity_check !== "ok")
        throw new Error("Backup integrity check failed.");
      if (!snapshot.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='app_records'").get())
        throw new Error("Source is not an initialized application SQLite database.");
    } finally { snapshot.close(); }

    const handle = await open(temporary, "r");
    try { await handle.sync(); } finally { await handle.close(); }
    try { await link(temporary, output); }
    catch (error) {
      if (error.code === "EEXIST")
        throw new Error("Backup destination already exists; choose a new path.");
      throw error;
    }
    return { pages, bytes: (await stat(output)).size, output };
  } finally {
    try { database?.close(); }
    finally { await rm(tempDir, { recursive: true, force: true }); }
  }
}

async function main(args) {
  if (args.length !== 4 || args[0] !== "--source" || args[2] !== "--output" || !args[1] || !args[3])
    throw new Error("Usage: npm run db:backup:sqlite -- --source SOURCE.sqlite --output NEW_BACKUP.sqlite");
  const result = await backupSqliteApplication(args[1], args[3]);
  console.log(`Verified private SQLite backup: ${result.output} (${result.pages} pages, ${result.bytes} bytes).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : "SQLite backup failed.");
    process.exitCode = 1;
  });
