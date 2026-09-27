import { defineAgent } from "eve";
import { workflowConfiguration } from "../../../../agent/lib/workflow";
import { modelWithBudget } from "../../../../lib/budgets/model";
import { prepareRuntimeModelCall } from "../../../../agent/lib/budgets";
import { recordedModel } from "./lib/fixture-model";

export default defineAgent({
  ...workflowConfiguration(),
  defaultTools: false,
  modelContextWindowTokens: 8192,
  model: process.env.TEST_DEFAULT_PROVIDER === "1" ? "openai/gpt-5.6-luna-fast" : modelWithBudget(recordedModel,prepareRuntimeModelCall),
});
