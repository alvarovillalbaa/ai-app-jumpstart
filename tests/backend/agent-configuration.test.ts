import { expect,it } from "vitest";
import { agentConfiguration } from "../../agent/lib/configuration";

it("enables native instrumentation without replacing default or PostgreSQL Workflow selection",() => {
  const local = agentConfiguration({ NODE_ENV: "test" });
  expect(local.experimental).toEqual({ instrumentationProviders: true });expect(local.build).toBeUndefined();
  const postgres = agentConfiguration({ NODE_ENV: "test",EVE_WORKFLOW_PROVIDER: "postgres" });
  expect(postgres.experimental).toEqual({ instrumentationProviders: true,workflow: { world: "@jumpstart/workflow-postgres" } });
  expect(postgres.build?.externalDependencies).toContain("@jumpstart/workflow-postgres");
  expect(postgres.build?.externalDependencies).toContain("@workflow/world-postgres");
});
it("retains invalid-world and Vercel/PostgreSQL configuration denial",() => {
  expect(() => agentConfiguration({ NODE_ENV: "test",EVE_WORKFLOW_PROVIDER: "unknown" })).toThrow("default or postgres");
  expect(() => agentConfiguration({ NODE_ENV: "test",VERCEL: "1",EVE_WORKFLOW_PROVIDER: "postgres" })).toThrow("default Vercel Workflow world");
});
