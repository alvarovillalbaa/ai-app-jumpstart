import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({ defaultTools: false,modelContextWindowTokens: 8192,
  model: mockModel(({ lastUserMessage,tools,toolResults }) => {
    if (!tools.some(tool => tool.name === "connection_search")) return "Reference disabled.";
    const message = lastUserMessage ?? "";
    if (!toolResults.length) return { toolCalls: [{ name: "connection_search",input: { connection: "reference",keywords: "catalog",limit: 10 } }] };
    if (toolResults.some(result => result.name === "connection_search" && result.isError)) return "Reference unavailable; I cannot verify catalog data.";
    if (message.includes("discovery-probe")) return JSON.stringify(tools.map(tool => tool.name));
    const remote = toolResults.find(result => result.name.startsWith("reference__"));
    if (remote) {
      const mcpError = typeof remote.output === "object" && remote.output !== null && "isError" in remote.output && remote.output.isError === true;
      return remote.isError || mcpError ? "Catalog request rejected; no result is available." : `Reference result: ${JSON.stringify(remote.output)}`;
    }
    return { toolCalls: [{ name: "reference__catalog_get",input: { id: message.includes("missing-probe") ? "missing" : "example" } }] };
  }),
});
