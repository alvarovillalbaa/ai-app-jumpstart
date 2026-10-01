import { existsSync } from "node:fs";
import { mkdtemp,readFile,readdir,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect,it } from "vitest";
import { saveUploadDownload } from "../../scripts/download-upload";
import { MAX_UPLOAD_BYTES } from "../../lib/uploads/validation";

it("publishes a complete private download without replacing an existing file",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-download-file-"));
  const output = join(directory,"private.txt");
  try {
    expect(await saveUploadDownload(output,new Response("private",{ headers: {
      "content-type": "application/octet-stream","content-length": "7",
    } }))).toEqual({ file: output,size: 7 });
    expect(await readFile(output,"utf8")).toBe("private");
    await expect(saveUploadDownload(output,new Response("new",{ headers: {
      "content-type": "application/octet-stream",
    } }))).rejects.toThrow("already exists");
    expect(await readFile(output,"utf8")).toBe("private");
  } finally { await rm(directory,{ recursive: true,force: true }); }
});

it("leaves no file after a truncated or over-limit download",async () => {
  const directory = await mkdtemp(join(tmpdir(),"jumpstart-download-failure-"));
  const output = join(directory,"incomplete.bin");
  try {
    await expect(saveUploadDownload(output,new Response("short",{ headers: {
      "content-type": "application/octet-stream","content-length": "6",
    } }))).rejects.toThrow("incomplete");
    expect(existsSync(output)).toBe(false);
    await expect(saveUploadDownload(output,new Response(Buffer.alloc(MAX_UPLOAD_BYTES+1),{ headers: {
      "content-type": "application/octet-stream",
    } }))).rejects.toThrow("file limit");
    expect(existsSync(output)).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  } finally { await rm(directory,{ recursive: true,force: true }); }
});
