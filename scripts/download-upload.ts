import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { link, mkdtemp, open, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { MAX_UPLOAD_BYTES } from "../lib/uploads/validation";

/** Publish a bounded owner download privately, atomically and without clobbering. */
export async function saveUploadDownload(output: string,response: Response) {
  if (!output || output.includes("\u0000")) throw new Error("Provide an output file path.");
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/octet-stream") {
    throw new Error("Upload download did not return binary content.");
  }
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) < 1 || Number(declared) > MAX_UPLOAD_BYTES)) {
    throw new Error("Upload download exceeds the file limit.");
  }
  const destination = resolve(output);
  if (existsSync(destination)) throw new Error("Download destination already exists; choose a new file.");
  const directory = await mkdtemp(join(dirname(destination), ".jumpstart-download-"));
  const temporary = join(directory,`${randomUUID()}.bin`);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(temporary,"wx",0o600);
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Upload download has no body.");
    let size = 0;
    try {
      while (true) {
        const { value,done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_UPLOAD_BYTES) throw new Error("Upload download exceeds the file limit.");
        await file.writeFile(value);
      }
    } finally { await reader.cancel().catch(() => {});reader.releaseLock(); }
    if (!size || declared && size !== Number(declared)) throw new Error("Upload download is incomplete.");
    await file.sync();
    await file.close();file = undefined;
    await link(temporary,destination);
    return { file: destination,size };
  } finally {
    await file?.close();
    await rm(directory,{ recursive: true,force: true });
  }
}
