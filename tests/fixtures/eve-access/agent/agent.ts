import { defineAgent } from "eve";
import { agentConfiguration } from "../../../../agent/lib/configuration";
import { modelWithBudget } from "../../../../lib/budgets/model";
import { prepareRuntimeModelCall } from "../../../../agent/lib/budgets";
import { recordedModel } from "./lib/fixture-model";

export default defineAgent({
  ...agentConfiguration(),
  defaultTools: false,
  modelContextWindowTokens: 8192,
  model: process.env.TEST_DEFAULT_PROVIDER === "1" ? "openai/gpt-5.6-luna-fast" : modelWithBudget(recordedModel,prepareRuntimeModelCall),
});
