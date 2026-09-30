import { mkdtemp,rm,symlink,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,expect,it } from "vitest";
import { readBoundedRegularFile } from "../../lib/security/read-bounded-file.mjs";

let directory = "";
afterEach(async () => { if (directory) await rm(directory,{ recursive: true,force: true });directory = ""; });

it("reads a regular file through a bounded stable descriptor",async () => {
  directory = await mkdtemp(join(tmpdir(),"jumpstart-bounded-file-"));
  const path = join(directory,"input.json");
  await writeFile(path,"{\"ok\":true}");
  await expect(readBoundedRegularFile(path,{ minBytes: 1,maxBytes: 32 })).resolves.toEqual(Buffer.from("{\"ok\":true}"));
});

it("rejects symlinks and out-of-bounds files",async () => {
  directory = await mkdtemp(join(tmpdir(),"jumpstart-bounded-file-"));
  const path = join(directory,"input"),link = join(directory,"link"),empty = join(directory,"empty");
  await writeFile(path,"12345");
  await writeFile(empty,"");
  await symlink(path,link);
  await expect(readBoundedRegularFile(link,{ minBytes: 1,maxBytes: 8 })).rejects.toThrow();
  await expect(readBoundedRegularFile(path,{ minBytes: 1,maxBytes: 4 })).rejects.toThrow("size bounds");
  await expect(readBoundedRegularFile(empty,{ minBytes: 1,maxBytes: 8 })).rejects.toThrow("size bounds");
});
