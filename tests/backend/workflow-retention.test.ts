import { expect,it } from "vitest";
import { agentConfiguration } from "../../agent/lib/configuration";
import { requireReplayRetention,workflowRunRetention } from "../../scripts/workflow-retention.mjs";

it("accepts only the supported native retention modes without exposing invalid values",() => {
  expect(workflowRunRetention(undefined)).toBe("default");expect(workflowRunRetention("default")).toBe("default");expect(workflowRunRetention("0")).toBe(0);
  for (const value of ["","00","1","30d","-1","false","private-fixture-secret"]) {
    expect(() => workflowRunRetention(value)).toThrow("Workflow retention must be default or 0.");
    try { workflowRunRetention(value); } catch (error) { expect(String(error)).not.toContain("private-fixture-secret"); }
  }
});

it("composes native zero retention with both worlds and existing instrumentation",() => {
  expect(agentConfiguration({ NODE_ENV: "test",EVE_WORKFLOW_RETENTION: "0" }).experimental).toEqual({ instrumentationProviders: true,workflow: { retention: 0 } });
  expect(agentConfiguration({ NODE_ENV: "test",EVE_WORKFLOW_RETENTION: "0",EVE_WORKFLOW_PROVIDER: "postgres" })).toMatchObject({
    experimental: { instrumentationProviders: true,workflow: { world: "@jumpstart/workflow-postgres",retention: 0 } },
    build: { externalDependencies: ["@jumpstart/workflow-postgres","@workflow/world-postgres"] },
  });
  expect(agentConfiguration({ NODE_ENV: "test",EVE_WORKFLOW_RETENTION: "default" }).experimental).toEqual({ instrumentationProviders: true });
});

it("refuses immediate purging for account chat at build and runtime preflight",() => {
  for (const env of [{ NODE_ENV: "test" as const,AI_CHAT_ENABLED: "true",EVE_WORKFLOW_RETENTION: "0" },{ NODE_ENV: "test" as const,AI_CHAT_ENABLED: "true",WORKFLOW_EXPECTED_RETENTION: "0" }]) {
    expect(() => requireReplayRetention(env)).toThrow("Account chat requires default Workflow retention");
    expect(() => agentConfiguration(env)).toThrow("Account chat requires default Workflow retention");
  }
  expect(requireReplayRetention({ NODE_ENV: "test",AI_CHAT_ENABLED: "false",EVE_WORKFLOW_RETENTION: "0" })).toBe(0);
  expect(requireReplayRetention({ NODE_ENV: "test",AI_CHAT_ENABLED: "true" })).toBe("default");
});
