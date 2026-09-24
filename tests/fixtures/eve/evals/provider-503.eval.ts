import { defineEval } from "eve/evals";

export default defineEval({
  description: "A model service error ends the turn without running a tool or fabricating an answer.",
  async test(t) {
    await t.send("provider-503-fixture: answer using the model.");
    t.event("turn.failed");
    t.usedNoTools();
    t.notEvent("message.completed");
  },
});
