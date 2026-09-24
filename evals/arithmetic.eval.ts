import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
export default defineEval({
  description: "The configured model executes a real arithmetic tool and reports the result.",
  async test(t) {
    await t.send("Use the calculate tool to multiply 17 by 23. Reply with the result.");
    t.succeeded();
    t.calledTool("calculate");
    t.check(t.reply, includes("391"));
  },
});
