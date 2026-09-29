import { defineEval } from "eve/evals";
import { equals, includes } from "eve/evals/expect";

const marker = "cobalt-orchid-47";

export default defineEval({
  description: "A follow-up turn keeps the same session and recalls a user-provided detail.",
  async test(t) {
    const first = await t.send(`Remember this project codename for our conversation: ${marker}. Acknowledge briefly.`);
    first.succeeded();

    const second = await t.send("What project codename did I give you? Reply with the codename.");
    t.check(second.sessionId, equals(first.sessionId));
    second.succeeded();
    t.check(second.message, includes(marker));
  },
});
