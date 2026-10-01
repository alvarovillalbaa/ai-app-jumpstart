import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
export default defineEval({ description: "A missing remote record stays an explicit error.",async test(t) {
  await t.send("missing-probe: read a nonexistent reference item.");t.succeeded();
  t.calledTool("reference__catalog_get",{ count: 1 });t.check(t.reply,includes("Catalog request rejected"));
} });
