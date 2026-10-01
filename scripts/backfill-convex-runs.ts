import { runRepairResult } from "../lib/agent-access/run-contract";
import { accessOwner,operationId } from "../lib/agent-access/contract";
import { getSessionAccessStore } from "../lib/agent-access/store";

const args = process.argv.slice(2),values: Record<string,string> = {};
let apply = false;
for (let i = 0; i < args.length; i++) {
  const flag = args[i];
  if (flag === "--apply" && !apply) { apply = true;continue; }
  if (!["--tenant","--subject","--operation"].includes(flag) || values[flag] !== undefined || !args[i+1] || args[i+1].startsWith("--"))
    throw new Error("Usage: npm run runs:backfill -- --tenant TENANT --subject SUBJECT --operation UUID [--apply]");
  values[flag] = args[++i];
}
const owner = accessOwner.parse({ tenant: values["--tenant"],subject: values["--subject"] }),operation = operationId.parse(values["--operation"]);
if (process.env.DATA_PROVIDER !== "convex") throw new Error("This command backfills legacy Convex run indexes. SQL migrations backfill their indexes transactionally.");
const store = await getSessionAccessStore();
try {
  if (!await store.getOperation(owner,operation)) throw new Error("Conversation not found for the selected owner.");
  if (!apply) console.log("Preview: backfill retained projection metadata for the selected conversation; no model request or source replay. Pass --apply to write.");
  else {
    let after = 0,processed = 0;
    for (let page = 0; page < 10_000; page++) {
      const result = runRepairResult.parse(await store.rebuildRuns(owner,operation,{ after,limit: 100 }));
      processed += result.processed;
      if (result.complete) { console.log(JSON.stringify({ processed,indexedThrough: result.nextIndex,complete: true }));break; }
      if (result.nextIndex <= after) throw new Error("Run backfill did not advance. Inspect retained projection data before retrying from zero.");
      after = result.nextIndex;
      if (page === 9999) throw new Error("Run backfill exceeded its page limit; committed metadata remains safe to retry.");
    }
  }
} finally { await store.close(); }
