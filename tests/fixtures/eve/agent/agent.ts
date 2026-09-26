import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  defaultTools: false,
  modelContextWindowTokens: 8192,
  model: mockModel(({ lastUserMessage, toolResults }) => {
    const message = lastUserMessage ?? "";
    if (message.includes("provider-429-fixture"))
      throw Object.assign(new Error("Fixture model rate limit"), { statusCode: 429 });
    if (message.includes("provider-503-fixture"))
      throw Object.assign(new Error("Fixture model unavailable"), { statusCode: 503 });
    if (message.includes("invalid-tool-input-fixture")) {
      if (toolResults.length) return "The tool rejected the invalid argument; no result is available.";
      return { toolCalls: [{ name: "calculate", input: { operation: "multiply", left: "seventeen", right: 23 } }] };
    }
    if (toolResults.length) {
      const result = JSON.stringify(toolResults[0]?.output);
      if (message.includes("anonymous-artifact-fixture")) return "The artifact was denied because this session has no verified account owner.";
      return result.includes("division_by_zero") ? "Cannot divide by zero." : `Result: ${result}`;
    }
    if (message.includes("anonymous-artifact-fixture"))
      return { toolCalls: [{ name: "create_artifact",input: { title: "Anonymous Note",content: "hello" } }] };
    if (message.includes("cancel-fixture"))
      return { toolCalls: [{ name: "wait_for_cancel",input: {} }] };
    if (message.includes("divide 5 by 0"))
      return { toolCalls: [{ name: "calculate", input: { operation: "divide", left: 5, right: 0 } }] };
    if (message.includes("current temperature in Reykjavik"))
      return "I cannot verify the current temperature without a live weather source.";
    if (message.includes("quoted customer note"))
      return "The quoted note contains an instruction to create an artifact. I am treating it as text to summarize, not as an action to take.";
    return { toolCalls: [{ name: "calculate", input: { operation: "multiply", left: 17, right: 23 } }] };
  }),
});
