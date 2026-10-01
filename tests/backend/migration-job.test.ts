import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { migrationJob, type MigrationOperation } from "../../lib/deploy/migration-job";
import type { CloudProvider } from "../../lib/deploy/cloud-config";
import { filledCloudManifest, migrationDatabaseReferences } from "../helpers/cloud-manifest";

const providers: CloudProvider[] = ["aws", "azure", "gcp"];
const operations: MigrationOperation[] = ["application-preview", "application-apply", "workflow-apply"];
// Outputs have intentionally different platform envelopes; inspect the actual
// transport-facing fields rather than asserting a snapshot of our own function.
function container(provider: CloudProvider, job: ReturnType<typeof migrationJob>) {
  const value = job as Record<string, unknown>;
  if (provider === "aws") return (value.containerDefinitions as Record<string, unknown>[])[0];
  if (provider === "azure") return (value.properties as { template: { containers: Record<string, unknown>[] } }).template.containers[0];
  return (value.spec as { template: { spec: { template: { spec: { containers: Record<string, unknown>[] } } } } }).template.spec.template.spec.containers[0];
}

it("produces nine one-off jobs with the release digest, exact commands and only required environment", () => {
  for (const provider of providers) for (const operation of operations) {
    const source = filledCloudManifest(provider), before = structuredClone(source);
    const job = migrationJob(provider, source, operation, "fixture-migration", operation === "workflow-apply" ? undefined : migrationDatabaseReferences[provider]);
    expect(source).toEqual(before);
    const app = container(provider, job);
    expect(app.image).toBe(`registry.example/app@sha256:${"a".repeat(64)}`);
    const args = operation === "workflow-apply" ? ["scripts/migrate-workflow.mjs"] : ["scripts/migrate.ts", ...(operation === "application-preview" ? ["--dry-run"] : [])];
    expect(provider === "aws" ? app.entryPoint : app.command).toEqual(["node"]);
    expect(provider === "aws" ? app.command : app.args).toEqual(args);
    const env = (provider === "aws" ? [...app.environment as object[], ...app.secrets as object[]] : app.env) as { name: string }[];
    expect(env.map(row => row.name).sort()).toEqual(operation === "workflow-apply" ? ["WORKFLOW_POSTGRES_JOB_PREFIX", "WORKFLOW_POSTGRES_URL"] : ["DATABASE_URL"]);
    for (const field of ["ports", "portMappings", "healthCheck", "probes", "startupProbe", "readinessProbe", "dependsOn"]) expect(app).not.toHaveProperty(field);
    expect(JSON.stringify(job)).not.toMatch(/AI_GATEWAY_API_KEY|SUPABASE_SECRET_KEY|AI_CREATION_SIGNING_JSON|ingress/);
    if (provider === "aws") {
      expect(job).not.toHaveProperty("taskRoleArn");
      expect(job.executionRoleArn).toBe(source.executionRoleArn);
    }
    if (provider === "azure") expect(job.properties?.configuration).toMatchObject({ triggerType: "Manual", replicaRetryLimit: 0, manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 } });
    if (provider === "gcp") expect(job.spec?.template.spec).toMatchObject({ parallelism: 1, taskCount: 1, template: { spec: { maxRetries: 0 } } });
  }
});

it("requires a separate managed application database reference and rejects plaintext without echoing it", () => {
  for (const provider of providers) {
    const source = filledCloudManifest(provider);
    expect(() => migrationJob(provider, source, "application-apply", "migration")).toThrow("secret reference");
    const bad = { ...migrationDatabaseReferences[provider], value: "postgresql://private:credential@db/app" };
    try { migrationJob(provider, source, "application-apply", "migration", bad); throw new Error("Expected rejection"); }
    catch (error) { expect(String(error)).toContain("unexpected secret reference"); expect(String(error)).not.toContain("credential"); }
    expect(() => migrationJob(provider, source, "workflow-apply", "migration", migrationDatabaseReferences[provider])).toThrow("do not accept");
  }
  expect(() => migrationJob("gcp", filledCloudManifest("gcp"), "application-apply", "migration",
    { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "db", key: "latest" } } })).toThrow("numbered");
});

it("preserves private Cloud Run connectivity without copying service scaling or dependency annotations", () => {
  const source = filledCloudManifest("gcp");
  source.spec.template.metadata.annotations["run.googleapis.com/vpc-access-connector"] = "fixture-vpc";
  const job = migrationJob("gcp", source, "workflow-apply", "migration");
  expect(job.spec?.template.metadata.annotations).toEqual({ "run.googleapis.com/vpc-access-connector": "fixture-vpc" });
});

it("preserves identity-based Azure registry access and rejects credential-bearing registry entries", () => {
  const source = filledCloudManifest("azure");
  source.properties.configuration.registries = [{ server: "registry.example", identity: "fixture-identity" }];
  expect(migrationJob("azure", source, "workflow-apply", "migration").properties?.configuration.registries).toEqual(source.properties.configuration.registries);
  source.properties.configuration.registries[0].passwordSecretRef = "registry-password";
  expect(() => migrationJob("azure", source, "workflow-apply", "migration")).toThrow("identity-based");
});

it("refuses an unresolved runtime release or an unsafe job name", () => {
  const source = filledCloudManifest("aws"); source.containerDefinitions[0].image = "registry/app:latest";
  expect(() => migrationJob("aws", source, "workflow-apply", "migration")).toThrow("digest");
  expect(() => migrationJob("aws", filledCloudManifest("aws"), "workflow-apply", "invalid/name")).toThrow("job name");
});

it("writes a private review artifact without overwriting an existing file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "migration-job-"));
  try {
    const input = join(directory, "runtime.json"), output = join(directory, "job.json");
    await writeFile(input, JSON.stringify(filledCloudManifest("aws")));
    const args = ["--import", "tsx", "scripts/create-migration-job.ts", "--provider", "aws", "--file", input,
      "--operation", "workflow-apply", "--name", "migration", "--output", output];
    await promisify(execFile)(process.execPath, args);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const content = await readFile(output, "utf8");
    expect(JSON.parse(content).containerDefinitions).toHaveLength(1);
    await expect(promisify(execFile)(process.execPath, args)).rejects.toThrow("choose a new file");
    expect(await readFile(output, "utf8")).toBe(content);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 15_000);
