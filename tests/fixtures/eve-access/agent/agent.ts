import { access, appendFile } from "node:fs/promises";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
import { workflowConfiguration } from "../../../../agent/lib/workflow";

export default defineAgent({
  ...workflowConfiguration(),
  defaultTools: false,
  modelContextWindowTokens: 8192,
  model: mockModel(async ({ lastUserMessage,toolResults }) => {
    await appendFile(process.env.TEST_MODEL_RECEIPTS!, `${JSON.stringify({ message: lastUserMessage ?? "compaction" })}\n`);
    if (lastUserMessage?.includes("inflight-restart-test")) {
      const deadline = Date.now() + 60000;
      while (!await access(process.env.TEST_MODEL_GATE!).then(() => true, () => false)) {
        if (Date.now() > deadline) throw new Error("Fixture model gate timed out.");
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    if (lastUserMessage?.includes("loop-budget-test")) return { toolCalls: [{ name: "tick", input: {} }] };
    if (lastUserMessage?.includes("structured-fixture")) return { toolCalls: [{ name: "final_output",input: { title: "Deterministic title",summary: "Organized fixture notes.",items: ["First item","Second item"] } }] };
    if (lastUserMessage?.includes("artifact-fixture")) return toolResults.length === 0
      ? { toolCalls: [{ name: "create_artifact",input: { title: "Fixture artifact",content: "Exact approved plain-text payload." } }] }
      : "Artifact proposal resolved.";
    return "Deterministic owned response";
  }),
});
