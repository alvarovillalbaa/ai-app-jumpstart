import { defineAgent } from "eve";
import { workflowConfiguration } from "#lib/workflow.ts";

export default defineAgent({
  ...workflowConfiguration(),
  defaultTools: false,
  model: "openai/gpt-5.6-luna-fast",
});
