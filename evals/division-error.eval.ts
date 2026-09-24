import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "An arithmetic tool error is reported without fabricating a numeric result.",
  async test(t) {
    await t.send("Use the calculate tool to divide 5 by 0. Report the result or the tool error; do not guess a number.");
    t.succeeded();
    t.calledTool("calculate", { output: { ok: false, error: "division_by_zero" }, count: 1 });
    t.check(t.reply, includes(/(?:cannot|can't|undefined|division by zero)/i));
  },
});
