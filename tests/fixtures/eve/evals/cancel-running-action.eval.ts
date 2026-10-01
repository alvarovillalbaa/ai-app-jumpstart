import { defineEval } from "eve/evals";

export default defineEval({
  description: "Cancelling an in-flight tool turn reaches a cancelled boundary without a completed action.",
  async test(t) {
    const live = await t.start("cancel-fixture: run wait_for_cancel now.");
    await live.waitForEvent("actions.requested",{ data: { actions: actions => actions.some(action =>
      action.kind === "tool-call" && action.toolName === "wait_for_cancel") } });
    await live.cancel();
    const turn = await live.result();
    turn.event("turn.cancelled");
    turn.notEvent("action.result",{ data: { status: "completed" } });
  },
});
