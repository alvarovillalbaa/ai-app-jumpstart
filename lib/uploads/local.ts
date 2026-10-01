import { randomUUID } from "node:crypto";
import { mkdir, open, link, unlink, readFile, lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { uploadObjectKey, type PrivateUploadObjects } from "./contract";

function missing(error: unknown) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }

/** Private single-host blob store. The database metadata/scan state is separate. */
export function localUploadObjects(root: string): PrivateUploadObjects {
  const directory = resolve(root);
  const pathOf = (owner: Parameters<PrivateUploadObjects["get"]>[0], id: string) => join(directory,uploadObjectKey(owner,id));
  async function privateRoot(create: boolean) {
    if (create) await mkdir(directory,{ recursive: true,mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) {
      throw new Error("Upload storage root must be a private directory, not a symlink.");
    }
  }
  return {
    async put(owner,id,bytes) {
      const path = pathOf(owner,id),dir = dirname(path),temporary = join(dir,`.${randomUUID()}.tmp`);
      await privateRoot(true);
      await mkdir(dir,{ recursive: true,mode: 0o700 });
      try {
        const file = await open(temporary,"wx",0o600);
        try { await file.writeFile(Uint8Array.from(bytes));await file.sync(); }
        finally { await file.close(); }
        await link(temporary,path);
      } finally {
        try { await unlink(temporary); }
        catch (error) { if (!missing(error)) throw error; }
      }
    },
    async get(owner,id) {
      try { await privateRoot(false);return await readFile(pathOf(owner,id)); }
      catch (error) { if (missing(error)) return null; throw error; }
    },
    async delete(owner,id) {
      try { await privateRoot(false);await unlink(pathOf(owner,id));return true; }
      catch (error) { if (missing(error)) return false; throw error; }
    },
  };
}
