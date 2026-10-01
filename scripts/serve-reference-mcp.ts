import { referenceCatalog,startReferenceMcp } from "../lib/reference-mcp/server";
import { readBoundedRegularFile } from "../lib/security/read-bounded-file.mjs";

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--data" || args[2] !== "--port" || !/^\d+$/.test(args[3]) || Number(args[3]) < 1024 || Number(args[3]) > 65535)
  throw new Error("Use npm run mcp:reference -- --data CATALOG.json --port PORT (1024-65535).");
const catalog = referenceCatalog.parse(JSON.parse((await readBoundedRegularFile(args[1],{ minBytes: 1,maxBytes: 32768 })).toString("utf8")));
const service = await startReferenceMcp(catalog,{ port: Number(args[3]) });
console.log(JSON.stringify({ event: "reference_mcp_ready",url: service.url }));
for (const signal of ["SIGINT","SIGTERM"] as const) process.on(signal,() => { void service.close().then(() => process.exit(0)); });
