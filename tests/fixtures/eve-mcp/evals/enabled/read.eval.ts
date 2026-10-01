import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
export default defineEval({ description: "Native Eve discovers and reads the real bounded MCP server.",async test(t) {
  await t.send("Read the reference catalog example.");t.succeeded();
  t.calledTool("connection_search",{ count: 1 });t.calledTool("reference__catalog_get",{ count: 1 });
  t.check(t.reply,includes("Operator-provided reference content"));
} });
