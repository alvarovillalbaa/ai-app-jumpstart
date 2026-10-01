import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description: "The production artifact tool rejects an anonymous session without requesting approval or writing data.",
  async test(t) {
    await t.send("anonymous-artifact-fixture: create a private artifact titled Anonymous Note with the text hello.");
    t.succeeded();
    t.calledTool("create_artifact",{ status: "failed",output: { code: "TOOL_EXECUTION_DENIED" },count: 1 });
    t.notEvent("input.requested");
    t.check(t.reply,includes(/(?:denied|cannot|can't|unavailable)/i));
  },
});
