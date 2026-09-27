import { access, appendFile } from "node:fs/promises";
import { mockModel } from "eve/evals";
import { customProvider, wrapLanguageModel } from "ai";

export const fixtureModel = mockModel(async ({ lastUserMessage,toolResults }) => {
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
});
if (typeof fixtureModel === "string") throw new Error("Fixture requires a concrete mock model.");
export const recordedModel = wrapLanguageModel({ model: fixtureModel,
  ...(process.env.TEST_DEFAULT_PROVIDER === "1" ? { providerId: "gateway", modelId: "openai/gpt-5.6-luna-fast" } : {}),
  middleware: {
  async transformParams({ params }) {
    if (process.env.TEST_MODEL_LIMIT_RECEIPTS) await appendFile(process.env.TEST_MODEL_LIMIT_RECEIPTS,
      `${JSON.stringify({ maxOutputTokens: params.maxOutputTokens })}\n`);
    return params;
  },
} });
// Exercise production string-model resolution without a paid/network provider.
if (process.env.TEST_DEFAULT_PROVIDER === "1") globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
  languageModels: { "openai/gpt-5.6-luna-fast": recordedModel },
});
