import { access, appendFile } from "node:fs/promises";
import { mockModel } from "eve/evals";
import { customProvider, wrapLanguageModel } from "ai";
import { defaultMaxInputBytes, inputPayloadBytes } from "../../../../../lib/budgets/input";
import { parseReviewedUploadMessage } from "../../../../../lib/uploads/chat-reference";

export const fixtureModel = mockModel(async ({ lastUserMessage,toolResults,userMessages }) => {
    await appendFile(process.env.TEST_MODEL_RECEIPTS!, `${JSON.stringify({ message: lastUserMessage ?? "compaction" })}\n`);
    if (lastUserMessage?.startsWith("What was the code I gave you in my previous message?")) {
      const previous = userMessages.find(message => message.includes("hosted-follow-up-code: "));
      const code = previous?.match(/hosted-follow-up-code: ([0-9a-f-]{36})/i)?.[1];
      return code ?? "I cannot recall a code from the previous message.";
    }
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
    if (lastUserMessage?.startsWith("agent-upload-fixture ")) return toolResults.length < userMessages.filter(message => message.startsWith("agent-upload-fixture ")).length
      ? { toolCalls: [{ name: "read_upload_text",input: JSON.parse(lastUserMessage.slice("agent-upload-fixture ".length)) }] }
      : `Reviewed source: ${JSON.stringify(toolResults.at(-1)?.output)}`;
    const uploadMessage = lastUserMessage ? parseReviewedUploadMessage(lastUserMessage) : null;
    if (uploadMessage) {
      const { id,sha256,reviewRevision } = uploadMessage.upload;
      return toolResults.length < userMessages.filter(message => parseReviewedUploadMessage(message)).length
        ? { toolCalls: [{ name: "read_upload_text",input: { id,sha256,reviewRevision } }] }
        : `Reviewed source: ${JSON.stringify(toolResults.at(-1)?.output)}`;
    }
    return "Deterministic owned response";
});
if (typeof fixtureModel === "string") throw new Error("Fixture requires a concrete mock model.");
export const recordedModel = wrapLanguageModel({ model: fixtureModel,
  ...(process.env.TEST_DEFAULT_PROVIDER === "1" ? { providerId: "gateway", modelId: "openai/gpt-5.6-luna-fast" } : {}),
  middleware: {
  async transformParams({ params }) {
    if (process.env.TEST_MODEL_LIMIT_RECEIPTS) await appendFile(process.env.TEST_MODEL_LIMIT_RECEIPTS,
      `${JSON.stringify({ maxOutputTokens: params.maxOutputTokens,inputBytes: inputPayloadBytes(params,defaultMaxInputBytes) })}\n`);
    return params;
  },
} });
// Exercise production string-model resolution without a paid/network provider.
if (process.env.TEST_DEFAULT_PROVIDER === "1") globalThis.AI_SDK_DEFAULT_PROVIDER = customProvider({
  languageModels: { "openai/gpt-5.6-luna-fast": recordedModel },
});
