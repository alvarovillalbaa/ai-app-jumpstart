import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
export default defineEval({ description: "A stopped real MCP server produces a tool error and no fabricated data.",async test(t) {
  await t.send("Read the reference catalog example.");t.succeeded();
  t.calledTool("connection_search",{ status: "failed",count: 1 });t.notCalledTool("reference__catalog_get");
  t.check(t.reply,includes("Reference unavailable"));
} });
