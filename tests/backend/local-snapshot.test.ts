import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createLocalSnapshot, installLocalSnapshot, verifyLocalSnapshot } from "../../scripts/backup-local.mjs";

const execFileAsync = promisify(execFile),directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path,{ recursive: true,force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(),"jumpstart-local-snapshot-"));directories.push(root);
  const databasePath = join(root,"app.sqlite"),workflow = join(root,"workflow"),uploads = join(root,"uploads");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode=WAL; CREATE TABLE app_records(id TEXT PRIMARY KEY, content TEXT NOT NULL); INSERT INTO app_records VALUES ('one','original');");
  await mkdir(workflow,{ mode: 0o700 });await mkdir(uploads,{ mode: 0o700 });
  await writeFile(join(workflow,"version.txt"),"local-world\n",{ mode: 0o600 });
  await mkdir(join(workflow,"runs"),{ mode: 0o700 });
  await writeFile(join(workflow,"runs","session.json"),'{"state":"waiting"}',{ mode: 0o600 });
  await writeFile(join(uploads,"private-object"),Buffer.from([0,1,2,3]),{ mode: 0o600 });
  return { root,database,databasePath,workflow,uploads };
}

it("creates and verifies a stopped-service snapshot, then restores application, workflow and upload data",async () => {
  const f = await fixture();
  try {
    const snapshot = join(f.root,"snapshot"),restored = join(f.root,"restored");
    const create = await execFileAsync(process.execPath,["scripts/backup-local.mjs","--create","--app-db",f.databasePath,
      "--workflow-dir",f.workflow,"--uploads-dir",f.uploads,"--output",snapshot,"--stopped"]);
    expect(create.stdout).toContain("Verified local snapshot:");
    expect((await stat(snapshot)).mode & 0o777).toBe(0o700);
    expect((await stat(join(snapshot,"app.sqlite"))).mode & 0o777).toBe(0o600);
    expect(await verifyLocalSnapshot(snapshot)).toMatchObject({ uploads: "included",files: 4 });
    f.database.exec("UPDATE app_records SET content='changed later' WHERE id='one'");
    const verify = await execFileAsync(process.execPath,["scripts/backup-local.mjs","--verify",snapshot]);
    expect(verify.stdout).toContain("4 files");
    await execFileAsync(process.execPath,["scripts/backup-local.mjs","--restore",snapshot,"--output",restored]);
    expect(await verifyLocalSnapshot(restored)).toMatchObject({ uploads: "included",files: 4 });
    const copy = new DatabaseSync(join(restored,"app.sqlite"));
    try { expect(copy.prepare("SELECT content FROM app_records WHERE id='one'").get()?.content).toBe("original"); }
    finally { copy.close(); }
    expect(await readFile(join(restored,"workflow","runs","session.json"),"utf8")).toContain("waiting");
    expect(await readFile(join(restored,"uploads","private-object"))).toEqual(Buffer.from([0,1,2,3]));
  } finally { f.database.close(); }
});

it("rejects changed files, existing output and symlinks without publishing a partial snapshot",async () => {
  const f = await fixture();
  try {
    const snapshot = join(f.root,"snapshot");
    await expect(execFileAsync(process.execPath,["scripts/backup-local.mjs","--create","--app-db",f.databasePath,
      "--workflow-dir",f.workflow,"--no-uploads","--output",snapshot]))
      .rejects.toThrow("--stopped");
    expect(await readdir(f.root)).not.toContain("snapshot");
    await expect(execFileAsync(process.execPath,["scripts/backup-local.mjs","--create","--app-db",f.databasePath,
      "--workflow-dir",f.workflow,"--no-uploads","--output",snapshot,"--stopped"],
      { env: { ...process.env,UPLOAD_STORAGE_PROVIDER: "local",UPLOAD_LOCAL_ROOT: f.uploads } }))
      .rejects.toThrow("configured local uploads must be included");
    expect(await readdir(f.root)).not.toContain("snapshot");
    await createLocalSnapshot({ appDb: f.databasePath,workflowDir: f.workflow,uploadsDir: null,output: snapshot });
    await expect(createLocalSnapshot({ appDb: f.databasePath,workflowDir: f.workflow,uploadsDir: null,output: snapshot }))
      .rejects.toThrow("already exists");
    await writeFile(join(snapshot,"workflow","version.txt"),"tampered");
    await expect(verifyLocalSnapshot(snapshot)).rejects.toThrow("do not match");
    await symlink(f.databasePath,join(f.workflow,"linked-db"));
    const rejected = join(f.root,"rejected");
    await expect(createLocalSnapshot({ appDb: f.databasePath,workflowDir: f.workflow,uploadsDir: null,output: rejected }))
      .rejects.toThrow("symlinks are not supported");
    expect(await readdir(f.root)).not.toContain("rejected");
  } finally { f.database.close(); }
});

it("installs a verified snapshot only into fresh targets, including its private uploads",async () => {
  const f = await fixture();
  try {
    const snapshot = join(f.root,"snapshot"),mounts = join(f.root,"mounts");
    await createLocalSnapshot({ appDb: f.databasePath,workflowDir: f.workflow,uploadsDir: f.uploads,output: snapshot });
    await mkdir(mounts);
    const appDb = join(mounts,"app.sqlite"),workflowDir = join(mounts,"world"),uploadsDir = join(mounts,"objects");
    await expect(installLocalSnapshot(snapshot,{ appDb,workflowDir })).rejects.toThrow("upload target exactly");
    await writeFile(`${appDb}-wal`,"old WAL");
    await expect(installLocalSnapshot(snapshot,{ appDb,workflowDir,uploadsDir })).rejects.toThrow("old SQLite companion");
    expect(await readdir(mounts)).toEqual(["app.sqlite-wal"]);
    await rm(`${appDb}-wal`);
    expect(await installLocalSnapshot(snapshot,{ appDb,workflowDir,uploadsDir })).toMatchObject({ targets: 3,uploads: "included" });
    expect((await stat(appDb)).mode & 0o777).toBe(0o600);
    expect((await stat(workflowDir)).mode & 0o777).toBe(0o700);
    expect(await readFile(join(uploadsDir,"private-object"))).toEqual(Buffer.from([0,1,2,3]));
    await expect(installLocalSnapshot(snapshot,{ appDb,workflowDir,uploadsDir })).rejects.toThrow("already exists");
    const restored = new DatabaseSync(appDb);
    try { expect(restored.prepare("SELECT content FROM app_records WHERE id='one'").get()?.content).toBe("original"); }
    finally { restored.close(); }
  } finally { f.database.close(); }
});
