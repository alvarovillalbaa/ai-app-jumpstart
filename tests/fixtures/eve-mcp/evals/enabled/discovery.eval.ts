import { defineEval } from "eve/evals";
import { includes,equals } from "eve/evals/expect";
export default defineEval({ description: "Native connection filtering excludes an advertised write tool.",async test(t) {
  await t.send("discovery-probe: inspect the tools available after reference catalog discovery.");t.succeeded();
  t.calledTool("connection_search",{ count: 1 });t.notCalledTool("reference__catalog_delete");
  t.check(t.reply,includes("reference__catalog_get"));t.check(t.reply,includes("reference__catalog_list"));
  t.check((t.reply ?? "").includes("catalog_delete"),equals(false));
} });
