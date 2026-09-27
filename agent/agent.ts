import { defineAgent } from "eve";
import { agentConfiguration } from "#lib/configuration.ts";

export default defineAgent({
  ...agentConfiguration(),
  defaultTools: false,
  model: "openai/gpt-5.6-luna-fast",
});
