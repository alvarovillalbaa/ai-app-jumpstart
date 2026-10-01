import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

export default defineEval({
  description: "Rejecting a side-effect approval leaves the action unexecuted.",
  async test(t) {
    const proposal = await t.send("approval-fixture-cancel: prepare a private draft but do not publish it without my approval.");
    t.check(proposal.status, equals("waiting"));
    t.check(proposal.inputRequests.length, equals(1));
    t.check(proposal.inputRequests[0]?.action.toolName, equals("confirm_side_effect"));
    t.check(proposal.inputRequests[0]?.action.input, equals({ title: "Cancelled release",content: "Keep this draft private." }));
    proposal.notEvent("action.result");

    const request = t.requireInputRequest({
      toolName: "confirm_side_effect",
      input: { title: "Cancelled release",content: "Keep this draft private." },
    });
    await t.respond([{ requestId: request.requestId,optionId: "cancel" }]);

    t.succeeded();
    t.calledTool("confirm_side_effect", {
      status: "rejected",
      input: { title: "Cancelled release",content: "Keep this draft private." },
      count: 1,
    });
    t.notEvent("action.result", { data: { status: "completed" } });
    t.check(t.reply, includes("did not run"));
  },
});
