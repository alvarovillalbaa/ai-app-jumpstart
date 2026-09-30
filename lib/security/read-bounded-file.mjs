import { constants } from "node:fs";
import { lstat,open } from "node:fs/promises";

const MAX_BUFFERED_FILE_BYTES = 64 * 1024 * 1024;

function sameVersion(left,right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

/** Read one bounded regular file through a descriptor and reject path or content changes. */
export async function readBoundedRegularFileDetails(path,{ minBytes = 0,maxBytes }) {
  if (!Number.isSafeInteger(minBytes) || minBytes < 0 || !Number.isSafeInteger(maxBytes) ||
      maxBytes < minBytes || maxBytes > MAX_BUFFERED_FILE_BYTES)
    throw new Error("File read bounds are invalid.");
  const handle = await open(path,constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < BigInt(minBytes) || before.size > BigInt(maxBytes))
      throw new Error("File input must be a regular file within the permitted size bounds.");
    const pathBefore = await lstat(path,{ bigint: true });
    if (!sameVersion(before,pathBefore)) throw new Error("File input changed before it could be read.");

    const expectedSize = Number(before.size),buffer = Buffer.alloc(expectedSize + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer,bytesRead,buffer.length - bytesRead,bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }

    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path,{ bigint: true });
    if (bytesRead !== expectedSize || !sameVersion(before,after) || !sameVersion(before,pathAfter))
      throw new Error("File input changed while it was being read.");
    return { bytes: buffer.subarray(0,bytesRead),mode: Number(before.mode & 0o777n) };
  } finally { await handle.close(); }
}

export async function readBoundedRegularFile(path,bounds) {
  return (await readBoundedRegularFileDetails(path,bounds)).bytes;
}
