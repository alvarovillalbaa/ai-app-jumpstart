import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { access,appendFile } from "node:fs/promises";
import { agentConfiguration } from "../../../../agent/lib/configuration";

export default defineAgent({
  ...agentConfiguration(),defaultTools: false,modelContextWindowTokens: 64_000,
  model: mockModel(async ({ lastUserMessage }) => {
    await appendFile(process.env.TEST_RETENTION_RECEIPTS!,"called\n");
    const deadline = Date.now()+30_000;
    while (!await access(process.env.TEST_RETENTION_GATE!).then(() => true,() => false)) {
      if (Date.now() >= deadline) throw new Error("Fixture gate timed out.");
      await new Promise(resolve => setTimeout(resolve,50));
    }
    return `Retained fixture response: ${lastUserMessage}`;
  }),
});
