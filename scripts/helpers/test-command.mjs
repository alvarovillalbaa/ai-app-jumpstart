import { spawn } from "node:child_process";
import { once } from "node:events";

/** Capture bounded, complete stdout separately from diagnostic stderr. */
export async function testCommand(executable,args,options = {},secrets = []) {
  const child = spawn(executable,args,{ stdio: ["ignore","pipe","pipe"],...options });
  const chunks = [];let bytes = 0,stderr = "";
  const maximum = 1024*1024;
  child.stdout?.on("data",chunk => {
    bytes += chunk.length;
    if (bytes <= maximum) chunks.push(chunk);
  });
  child.stderr?.on("data",chunk => { stderr = (stderr+chunk).slice(-12000); });
  const [code,signal] = await once(child,"close");
  const stdout = Buffer.concat(chunks).toString("utf8");
  if (code !== 0 || signal) {
    let diagnostic = `${stdout}\n${stderr}`;
    for (const secret of secrets) if (secret) diagnostic = diagnostic.replaceAll(secret,"[redacted]");
    throw new Error(`${executable} failed (${signal ?? code}): ${diagnostic.slice(-12000)}`);
  }
  if (bytes > maximum) throw new Error(`${executable} stdout exceeded 1 MiB; refusing incomplete output.`);
  return stdout.trim();
}
