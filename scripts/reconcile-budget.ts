import { createSessionAccessStore } from "../lib/agent-access/store";
import { accessOwner, operationId } from "../lib/agent-access/contract";
import { createBudgetStore } from "../lib/budgets/store";
import { micros, settlementCorrection } from "../lib/budgets/contract";

const usage = `Usage:
  npm run budgets:reconcile -- show OPERATION_UUID --tenant TENANT --subject SUBJECT
  npm run budgets:reconcile -- correct OPERATION_UUID --tenant TENANT --subject SUBJECT \\
    --correction-id UUID --expected unknown|MICRO_USD --actual MICRO_USD \\
    --actor OPERATOR_ID --reason TEXT --evidence REFERENCE [--apply]`;
const [command,id,...args] = process.argv.slice(2);
if ((command !== "show" && command !== "correct") || !operationId.safeParse(id).success) {
  console.error(usage); process.exit(2);
}
const flags = new Map<string,string>();
let apply = false;
while (args.length) {
  const flag = args.shift()!;
  if (flag === "--apply" && !apply) { apply = true; continue; }
  const value = args.shift();
  if (!flag.startsWith("--") || value === undefined || flags.has(flag)) { console.error(usage); process.exit(2); }
  flags.set(flag,value);
}
const allowed = command === "show" ? ["--tenant","--subject"] :
  ["--tenant","--subject","--correction-id","--expected","--actual","--actor","--reason","--evidence"];
if ([...flags.keys()].some(flag => !allowed.includes(flag)) || (command === "show" && apply)) {
  console.error(usage); process.exit(2);
}
const owner = accessOwner.safeParse({ tenant: flags.get("--tenant"),subject: flags.get("--subject") });
if (!owner.success) { console.error(usage); process.exit(2); }
const key = { ...owner.data,operationId: id };
const parseAmount = (value: string | undefined) => value && /^(0|[1-9][0-9]*)$/.test(value) && micros.safeParse(Number(value)).success
  ? Number(value) : NaN;
const correction = command === "correct" ? settlementCorrection.safeParse({ ...key,
  correctionId: flags.get("--correction-id"),expectedActualMicros: flags.get("--expected") === "unknown" ? null : parseAmount(flags.get("--expected")),
  correctedActualMicros: parseAmount(flags.get("--actual")),actor: flags.get("--actor"),reason: flags.get("--reason"),
  evidenceRef: flags.get("--evidence") }) : null;
const requestedCorrection = correction?.success ? correction.data : null;
if (command === "correct" && !requestedCorrection) {
  console.error(usage); process.exit(2);
}

let access: Awaited<ReturnType<typeof createSessionAccessStore>> | undefined;
let budgets: Awaited<ReturnType<typeof createBudgetStore>> | undefined;
try {
  access = await createSessionAccessStore(); budgets = await createBudgetStore();
  const [reservation,conversation,attempts,corrections] = await Promise.all([
    budgets.inspectReservation(key),access.getOperation(owner.data,id),budgets.attemptCount(key),budgets.listCorrections(key),
  ]);
  const view = { operationId: id,owner: owner.data,reservation,conversationStatus: conversation?.status ?? "missing",
    sessionId: conversation?.sessionId ?? null,attempts,recentCorrections: corrections };
  if (command === "show") console.log(JSON.stringify(view,null,2));
  else if (!apply) console.log(JSON.stringify({ ...view,proposedCorrection: requestedCorrection,
    wouldConflict: reservation?.status !== "settled" || reservation.actualMicros !== requestedCorrection!.expectedActualMicros ||
      reservation.actualMicros === requestedCorrection!.correctedActualMicros,apply: false },null,2));
  else {
    const result = await budgets.correctSettlement(requestedCorrection!);
    console.log(JSON.stringify({ operationId: id,correctionId: requestedCorrection!.correctionId,result }));
    if (result !== "applied" && result !== "already_applied") process.exitCode = 1;
  }
} catch {
  // Provider errors can contain database URLs or secret credentials.
  console.error("Budget reconciliation failed. Check backend connectivity, migrations and credentials.");
  process.exitCode = 1;
} finally { await Promise.allSettled([access?.close(),budgets?.close()]); }
