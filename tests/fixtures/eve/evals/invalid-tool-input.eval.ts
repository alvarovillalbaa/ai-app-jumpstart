import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "Invalid typed tool input cannot produce a successful calculation.",
  async test(t) {
    await t.send("invalid-tool-input-fixture: multiply the supplied values.");
    t.succeeded();
    t.event("step.completed", { data: { finishReason: "tool-calls" }, count: 1 });
    t.usedNoTools();
    t.check(t.reply, includes(/(?:rejected|invalid|cannot)/i));
  },
});
