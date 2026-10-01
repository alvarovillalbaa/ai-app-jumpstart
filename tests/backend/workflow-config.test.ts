import { expect, it } from "vitest";
import { workflowConfiguration } from "../../agent/lib/workflow";
import { postgresWorkflowSettings } from "../../packages/workflow-postgres/config.mjs";

const env = { NODE_ENV: "test" as const, WORKFLOW_POSTGRES_URL: "postgresql://user:fixture@127.0.0.1/workflows", WORKFLOW_POSTGRES_JOB_PREFIX: "test_environment" };
it("keeps the default local/Vercel world unless a PostgreSQL build is explicitly requested", () => {
  expect(workflowConfiguration({ NODE_ENV: "test" })).toEqual({});
  expect(workflowConfiguration({ NODE_ENV: "test", VERCEL: "1" })).toEqual({});
  expect(workflowConfiguration({ NODE_ENV: "test", EVE_WORKFLOW_PROVIDER: "postgres" }).experimental?.workflow.world).toBe("@jumpstart/workflow-postgres");
  expect(() => workflowConfiguration({ NODE_ENV: "test", EVE_WORKFLOW_PROVIDER: "typo" })).toThrow();
  expect(() => workflowConfiguration({ NODE_ENV: "test", EVE_WORKFLOW_PROVIDER: "postgres", VERCEL: "1" })).toThrow();
});
it("never falls back to the application database or silently accepts malformed worker limits", () => {
  expect(() => postgresWorkflowSettings({ NODE_ENV: "test", DATABASE_URL: env.WORKFLOW_POSTGRES_URL })).toThrow("Set WORKFLOW_POSTGRES_URL explicitly");
  expect(postgresWorkflowSettings(env)).toMatchObject({ connectionString: env.WORKFLOW_POSTGRES_URL, queueConcurrency: 5, maxPoolSize: 10, jobPrefix: env.WORKFLOW_POSTGRES_JOB_PREFIX, applicationManagedShutdown: true });
  for (const change of [{ WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "0" }, { WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "5oops" }, { WORKFLOW_POSTGRES_MAX_POOL_SIZE: "6" }, { WORKFLOW_POSTGRES_JOB_PREFIX: "" }, { WORKFLOW_POSTGRES_URL: "https://user:secret@example.com/db" }]) {
    expect(() => postgresWorkflowSettings({ ...env, ...change })).toThrow();
  }
});
it("rejects process-lifetime workers in known function hosts without leaking credentials", () => {
  for (const host of [{ VERCEL: "1" }, { AWS_LAMBDA_FUNCTION_NAME: "function" }]) {
    expect(() => postgresWorkflowSettings({ ...env, ...host })).toThrow("continuously running worker");
  }
  expect(() => postgresWorkflowSettings({ ...env, WORKFLOW_POSTGRES_URL: "secret" })).toThrow("Set WORKFLOW_POSTGRES_URL explicitly");
});
