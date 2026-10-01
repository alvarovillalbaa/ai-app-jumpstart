import { createSessionAccessStore } from "../lib/agent-access/store";
import { createBudgetStore } from "../lib/budgets/store";
import { outstandingOptions } from "../lib/budgets/contract";
import { inspectOutstandingStarts } from "../lib/budgets/outstanding";

const usage = "Usage: npm run starts:inspect -- list [--limit 1..100] [--cursor TIME.OPERATION_UUID]";
const args = process.argv.slice(2);
if (args.shift() !== "list") { console.error(usage); process.exit(2); }
const parsed: { limit?: number;cursor?: string } = {};
while (args.length) {
  const flag = args.shift(),value = args.shift();
  if (flag === "--limit" && value && parsed.limit === undefined && /^\d+$/.test(value)) parsed.limit = Number(value);
  else if (flag === "--cursor" && value && parsed.cursor === undefined) parsed.cursor = value;
  else { console.error(usage); process.exit(2); }
}
const options = outstandingOptions.safeParse(parsed);
if (!options.success) { console.error(usage); process.exit(2); }

let access: Awaited<ReturnType<typeof createSessionAccessStore>> | undefined;
let budgets: Awaited<ReturnType<typeof createBudgetStore>> | undefined;
try {
  access = await createSessionAccessStore();
  budgets = await createBudgetStore();
  console.log(JSON.stringify(await inspectOutstandingStarts(access,budgets,options.data),null,2));
} catch {
  // Driver errors can contain connection strings or credentials.
  console.error("Start inventory failed. Check backend connectivity, schema and credentials.");
  process.exitCode = 1;
} finally { await Promise.allSettled([access?.close(),budgets?.close()]); }
