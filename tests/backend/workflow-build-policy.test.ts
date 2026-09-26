import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { verifyWorkflowBuild, writeWorkflowBuildMarker } from "../../scripts/workflow-build-policy.mjs";

const paths: string[] = [];
function marker() {
  const directory = mkdtempSync(join(tmpdir(), "jumpstart-world-"));
  paths.push(directory);
  return join(directory, "provider");
}
afterEach(() => {
  for (const directory of paths.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("records the compiled world and accepts only matching runtime settings", () => {
  const path = marker();
  expect(writeWorkflowBuildMarker({ EVE_WORKFLOW_PROVIDER: "postgres" }, path)).toBe("postgres");
  expect(readFileSync(path, "utf8")).toBe("postgres\n");
  expect(verifyWorkflowBuild({ WORKFLOW_EXPECTED_PROVIDER: "postgres", WORKFLOW_POSTGRES_URL: "postgresql://private" }, path)).toBe("postgres");
  expect(() => verifyWorkflowBuild({ WORKFLOW_POSTGRES_URL: "postgresql://private" }, path)).not.toThrow();
  expect(() => writeWorkflowBuildMarker({ EVE_WORKFLOW_PROVIDER: "typo" }, path)).toThrow("Workflow provider must be default or postgres.");
});

it("refuses a default-world image configured as a durable PostgreSQL worker", () => {
  const path = marker();
  writeWorkflowBuildMarker({}, path);
  expect(verifyWorkflowBuild({}, path)).toBe("default");
  expect(() => verifyWorkflowBuild({ WORKFLOW_EXPECTED_PROVIDER: "postgres" }, path)).toThrow("Workflow build is default");
  expect(() => verifyWorkflowBuild({ WORKFLOW_POSTGRES_URL: "postgresql://private" }, path)).toThrow("cannot make a default-world build durable");
  expect(() => verifyWorkflowBuild({ EVE_WORKFLOW_PROVIDER: "postgres" }, path)).toThrow("Workflow build is default");
});

it("fails closed for an unmarked, malformed or unconfigured PostgreSQL build", () => {
  const path = marker();
  expect(verifyWorkflowBuild({}, path)).toBeUndefined();
  expect(() => verifyWorkflowBuild({ WORKFLOW_EXPECTED_PROVIDER: "postgres" }, path)).toThrow("marker is missing or invalid");
  writeFileSync(path, "unexpected\n");
  expect(() => verifyWorkflowBuild({}, path)).toThrow("Workflow build marker is invalid.");
  writeWorkflowBuildMarker({ EVE_WORKFLOW_PROVIDER: "postgres" }, path);
  expect(() => verifyWorkflowBuild({}, path)).toThrow("requires WORKFLOW_POSTGRES_URL");
});
