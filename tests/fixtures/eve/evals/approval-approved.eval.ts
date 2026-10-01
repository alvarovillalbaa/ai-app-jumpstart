import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

export default defineEval({
  description: "A side-effecting tool stays parked until approval, then executes once with the approved input.",
  async test(t) {
    const proposal = await t.send("approval-fixture-approve: publish a private draft with the exact requested title and content.");
    t.check(proposal.status, equals("waiting"));
    t.check(proposal.inputRequests.length, equals(1));
    t.check(proposal.inputRequests[0]?.action.toolName, equals("confirm_side_effect"));
    t.check(proposal.inputRequests[0]?.action.input, equals({ title: "Approved release",content: "Publish this exact draft." }));
    proposal.notEvent("action.result");

    const request = t.requireInputRequest({
      toolName: "confirm_side_effect",
      input: { title: "Approved release",content: "Publish this exact draft." },
    });
    await t.respond([{ requestId: request.requestId,optionId: "approve" }]);

    t.succeeded();
    t.calledTool("confirm_side_effect", {
      status: "completed",
      input: { title: "Approved release",content: "Publish this exact draft." },
      output: { performed: true,title: "Approved release" },
      count: 1,
    });
    t.check(t.reply, includes("after approval"));
  },
});
