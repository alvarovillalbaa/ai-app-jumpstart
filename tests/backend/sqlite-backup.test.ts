import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { backupSqliteApplication } from "../../scripts/backup-sqlite.mjs";

const directories: string[] = [];
const execFileAsync = promisify(execFile);
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path,{ recursive: true,force: true }))); });

it("backs up uncheckpointed WAL writes and restores a writable, private application database",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-backup-"));directories.push(directory);
  const source = join(directory,"app.sqlite"),destination = join(directory,"backup.sqlite");
  const database = new DatabaseSync(source);
  try {
    database.exec("PRAGMA journal_mode=WAL; CREATE TABLE app_records(id TEXT PRIMARY KEY, content TEXT NOT NULL);");
    const id = randomUUID();
    database.prepare("INSERT INTO app_records(id,content) VALUES (?,?)").run(id,"private fixture");
    expect((await stat(`${source}-wal`)).size).toBeGreaterThan(0);
    const { stdout } = await execFileAsync(process.execPath,["scripts/backup-sqlite.mjs","--source",source,"--output",destination]);
    expect(stdout).toContain("Verified private SQLite backup:");
    expect((await stat(destination)).size).toBeGreaterThan(0);
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter(name => name.startsWith("backup.sqlite-"))).toEqual([]);
    database.prepare("UPDATE app_records SET content=? WHERE id=?").run("changed later",id);
    const restoredPath = join(directory,"restored.sqlite");
    await copyFile(destination,restoredPath);
    const restored = new DatabaseSync(restoredPath);
    try {
      expect(restored.prepare("SELECT content FROM app_records WHERE id=?").get(id)?.content).toBe("private fixture");
      restored.prepare("INSERT INTO app_records(id,content) VALUES (?,?)").run(randomUUID(),"restored write");
      expect(restored.prepare("SELECT count(*) AS count FROM app_records").get()?.count).toBe(2);
    } finally { restored.close(); }
    expect((await readdir(directory)).filter(name => name.startsWith(".sqlite-backup-"))).toEqual([]);
  } finally { database.close(); }
});

it("never overwrites a backup and cleans temporary files when the source is wrong",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-backup-"));directories.push(directory);
  const source = join(directory,"wrong.sqlite"),destination = join(directory,"existing.sqlite");
  const database = new DatabaseSync(source);
  database.exec("CREATE TABLE unrelated(id INTEGER)");database.close();
  await writeFile(destination,"existing private backup",{ mode: 0o600 });
  await expect(backupSqliteApplication(source,destination)).rejects.toThrow("already exists");
  expect(await readFile(destination,"utf8")).toBe("existing private backup");
  await rm(destination);
  await expect(backupSqliteApplication(source,destination)).rejects.toThrow("initialized application");
  await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await readdir(directory)).filter(name => name.startsWith(".sqlite-backup-"))).toEqual([]);
});
