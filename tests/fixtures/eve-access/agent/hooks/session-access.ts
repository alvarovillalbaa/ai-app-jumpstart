import { defineHook } from "eve/hooks";
import { access, appendFile } from "node:fs/promises";
import productionHook from "../../../../../agent/hooks/session-access";
export default defineHook({ events: {
  ...productionHook.events,
  "turn.started": async (_event, ctx) => {
    const deadline = Date.now() + 10000;
    while (!await access(process.env.TEST_RECEIPT_GATE!).then(() => true, () => false)) {
      if (Date.now() > deadline) throw new Error("Fixture receipt gate timed out.");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await productionHook.events!["turn.started"]!(_event, ctx);
  },
  "turn.failed": async (event,ctx) => {
    await productionHook.events!["turn.failed"]!(event,ctx);
    await appendFile(process.env.TEST_FAILURE_RECEIPTS!, "turn-failed\n");
  },
} });
