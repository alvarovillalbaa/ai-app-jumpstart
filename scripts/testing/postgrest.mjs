import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

// Official v16.3 release assets, checked against GitHub's published SHA-256.
// These are test tools, never production runtime dependencies.
const release = {
  "darwin-arm64": ["macos-aarch64", "b4b6f45030c7ca94a653d775d74ed48037f7428b0a5a52eae6a90d654a2f0e41"],
  "darwin-x64": ["macos-x86-64", "1999ea82fc1b2b4b2fa3071757aa482cf0ebe24a7b416053856cf208d95a1515"],
  "linux-arm64": ["linux-static-aarch64", "25bb1eab438f92c26514ff126104400562b8560d0352f128606c3fb726eac242"],
  "linux-x64": ["linux-static-x86-64", "4eb414eb948c8800863cc8c9896a17b611b2dccf9ff581f4d57f42ec9ccee40d"],
};
export async function installPostgrest(directory) {
  const asset = release[`${process.platform}-${process.arch}`];
  if (!asset) throw new Error("Local PostgREST tests require macOS/Linux on x64/arm64. Use a disposable Supabase project on other platforms.");
  await mkdir(directory, { recursive: true });
  const archive = join(directory, "postgrest.tar.xz");
  const response = await fetch(`https://github.com/PostgREST/postgrest/releases/download/v16.3/postgrest-v16.3-${asset[0]}.tar.xz`, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Cannot download pinned PostgREST test binary (${response.status}).`);
  await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
  if (createHash("sha256").update(await readFile(archive)).digest("hex") !== asset[1]) throw new Error("PostgREST archive checksum mismatch.");
  const unpack = spawn("tar", ["-xJf", archive, "-C", directory], { stdio: "inherit" });
  const [code] = await once(unpack, "exit");
  if (code !== 0) throw new Error("Cannot unpack PostgREST test binary.");
  const executable = join(directory, "postgrest");
  await chmod(executable, 0o700);
  return executable;
}
