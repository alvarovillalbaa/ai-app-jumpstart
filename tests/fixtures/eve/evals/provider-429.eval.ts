import { defineEval } from "eve/evals";

export default defineEval({
  description: "A model rate limit ends the turn without running a tool or fabricating an answer.",
  async test(t) {
    await t.send("provider-429-fixture: answer using the model.");
    t.event("turn.failed");
    t.usedNoTools();
    t.notEvent("message.completed");
  },
});
