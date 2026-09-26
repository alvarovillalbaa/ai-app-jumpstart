import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";

const maxFiles = 100_000;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
export const snapshotObjectName = new RegExp(`^uploads/uploads/v1/[a-f0-9]{64}/${uuid}$`);
function fail(message) { throw new Error(`Private upload snapshot: ${message}`); }

export async function privateUploadDirectory(path) {
  const details = await lstat(path);
  if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0)
    fail("expected a private, real directory.");
}

/** Walk only the opaque layout emitted by the local object backend. */
async function objectFiles(root) {
  const files = [];
  await privateUploadDirectory(root);
  async function visit(prefix, depth) {
    for (const name of await readdir(join(root, prefix))) {
      const path = prefix ? `${prefix}/${name}` : name;
      const details = await lstat(join(root, path));
      if (details.isSymbolicLink()) fail("symlinks are not supported.");
      if (details.isDirectory()) {
        if (!(depth === 0 && name === "uploads" || depth === 1 && name === "v1" || depth === 2 && /^[a-f0-9]{64}$/.test(name)))
          fail("unexpected object directory; resolve it before backup.");
        await privateUploadDirectory(join(root, path));
        await visit(path, depth + 1);
      } else if (details.isFile() && snapshotObjectName.test(`uploads/${path}`)) {
        if ((details.mode & 0o077) !== 0) fail("object file is readable by other users.");
        if (files.length >= maxFiles) fail("too many object files for one snapshot.");
        files.push(path);
      } else fail("unexpected object entry; resolve incomplete writes before backup.");
    }
  }
  await visit("", 0);
  return files.sort();
}

async function describeFile(root, path) {
  const handle = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || (before.mode & 0o077) !== 0) fail("expected a private regular object file.");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
    const after = await handle.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      fail("object changed while reading; stop every writer.");
    return { name: `uploads/${path}`, bytes, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

export async function describeUploadSnapshot(root) {
  const result = [];
  for (const path of await objectFiles(root)) result.push(await describeFile(root, path));
  return result;
}

/** New destination only, with no links and private permissions on every entry. */
export async function copyUploadSnapshot(source, destination) {
  const paths = await objectFiles(source);
  await mkdir(destination, { mode: 0o700 });
  let complete = false;
  try {
    for (const path of paths) {
      const parts = path.split("/");
      let parent = destination;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part);
        await mkdir(parent, { recursive: true, mode: 0o700 });
        await privateUploadDirectory(parent);
      }
      const input = await open(join(source, path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await input.stat();
        if (!before.isFile() || (before.mode & 0o077) !== 0) fail("expected a private regular object file.");
        const output = await open(join(destination, path), "wx", 0o600);
        try {
          let bytes = 0;
          for await (const chunk of input.createReadStream({ autoClose: false })) {
            // writeFile completes the whole chunk, unlike a single write().
            await output.writeFile(chunk); bytes += chunk.length;
          }
          await output.sync();
          const after = await input.stat();
          if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
            fail("object changed while copying; stop every writer.");
        } finally { await output.close(); }
      } finally { await input.close(); }
    }
    // Detect entry additions/removals during this stopped-writer copy too.
    if (JSON.stringify(await objectFiles(source)) !== JSON.stringify(paths)) fail("object tree changed while copying.");
    complete = true;
  } finally { if (!complete) await rm(destination, { recursive: true, force: true }); }
}

/** Compare captured bytes with a bounded, read-only view of the matching catalog.
 * Integrity-rejected bytes are evidence: retain them without granting release.
 */
export async function checkSnapshotUploadCatalog(connectionString, files) {
  const remaining = new Map(files.map(row => [row.name, row]));
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
  let rows = 0, integrityRejected = 0;
  await client.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let cursor = null;
    while (true) {
      const page = await client.query(`SELECT u.id,u.tenant,u.subject,u.state,u.size,u.sha256,s.reason
        FROM public.app_uploads u LEFT JOIN public.app_upload_scans s ON s.upload_id=u.id
        WHERE ($1::uuid IS NULL OR u.id>$1::uuid) ORDER BY u.id LIMIT 500`, [cursor]);
      for (const row of page.rows) {
        rows++;
        const namespace = createHash("sha256").update(JSON.stringify([row.tenant, row.subject])).digest("hex");
        const name = `uploads/uploads/v1/${namespace}/${row.id}`, object = remaining.get(name);
        if (row.state === "deleted") {
          if (object) fail("a deleted catalog entry still has bytes; resolve it before backup.");
        } else if (row.state === "rejected" && row.reason === "integrity") {
          // A rejected corrupt object must remain rejected after restoration.
          integrityRejected++;
        } else if (!object && !["pending", "deleting"].includes(row.state)) {
          fail("stored catalog entry is missing its object bytes.");
        } else if (object && (object.bytes !== row.size || object.sha256 !== row.sha256)) {
          fail("object bytes do not match their catalog entry.");
        }
        remaining.delete(name);
      }
      if (page.rows.length < 500) break;
      cursor = page.rows.at(-1).id;
    }
    if (remaining.size) fail("object bytes have no matching catalog entry.");
    await client.query("COMMIT");
    return { rows, objects: files.length, integrityRejected };
  } finally { await client.end(); }
}
