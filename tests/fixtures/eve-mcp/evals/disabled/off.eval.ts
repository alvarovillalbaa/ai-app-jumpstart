import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";
export default defineEval({ description: "Unconfigured deployments expose no reference or search tools.",async test(t) {
  await t.send("Read the reference catalog example.");t.succeeded();t.notCalledTool("connection_search");t.notCalledTool("reference__catalog_get");
  t.check(t.reply,includes("Reference disabled"));
} });
