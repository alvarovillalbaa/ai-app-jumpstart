import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect,it } from "vitest";
import { cleanupJob } from "../../lib/deploy/cleanup-job";
import type { CloudProvider } from "../../lib/deploy/cloud-config";
import { filledCloudManifest } from "../helpers/cloud-manifest";

const providers: CloudProvider[] = ["aws","azure","gcp"];
function configured(provider: CloudProvider) {
  const manifest = filledCloudManifest(provider);
  const app = provider === "aws" ? manifest.containerDefinitions[0] :
    provider === "azure" ? manifest.properties.template.containers[0] : manifest.spec.template.spec.containers[1];
  const env = provider === "aws" ? app.environment : app.env;
  env.push({ name: "UPLOAD_STORAGE_PROVIDER",value: "supabase" });
  if (provider === "aws") app.secrets.push({ name: "CRON_SECRET",
    valueFrom: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:cleanup-token" });
  else if (provider === "azure") {
    app.env.push({ name: "CRON_SECRET",secretRef: "cleanup-token" });
    manifest.properties.configuration.secrets.push({ name: "cleanup-token",
      keyVaultUrl: "https://fixture.vault.azure.net/secrets/cleanup-token/version1",identity: "fixture-identity" });
  } else app.env.push({ name: "CRON_SECRET",
    valueFrom: { secretKeyRef: { name: "cleanup-token",key: "1" } } });
  return manifest;
}
function container(provider: CloudProvider, job: ReturnType<typeof cleanupJob>) {
  const value = job as Record<string, unknown>;
  if (provider === "aws") return (value.containerDefinitions as Record<string, unknown>[])[0];
  if (provider === "azure") return (value.properties as { template: { containers: Record<string, unknown>[] } }).template.containers[0];
  return (value.spec as { template: { spec: { template: { spec: { containers: Record<string, unknown>[] } } } } }).template.spec.template.spec.containers[0];
}

it("derives one minimal cleanup container per cloud from a validated release",() => {
  for (const provider of providers) {
    const source = configured(provider),before = structuredClone(source);
    const job = cleanupJob(provider,source,"fixture-cleanup");
    expect(source).toEqual(before);
    const app = container(provider,job);
    expect(app.image).toBe(`registry.example/app@sha256:${"a".repeat(64)}`);
    expect(provider === "aws" ? app.entryPoint : app.command).toEqual(["node"]);
    expect(provider === "aws" ? app.command : app.args).toEqual(["scripts/run-upload-cleanup.mjs"]);
    const env = (provider === "aws" ? [...app.environment as object[],...app.secrets as object[]] : app.env) as { name: string }[];
    expect(env.map(row => row.name).sort()).toEqual(["APP_ORIGIN","CRON_SECRET"]);
    for (const field of ["ports","portMappings","healthCheck","probes","startupProbe","readinessProbe","dependsOn"])
      expect(app).not.toHaveProperty(field);
    expect(JSON.stringify(job)).not.toMatch(/AI_GATEWAY_API_KEY|SUPABASE_SECRET_KEY|WORKFLOW_POSTGRES_URL|ingress/);
    if (provider === "aws") {
      expect(job).not.toHaveProperty("taskRoleArn");
      expect(job).toHaveProperty("containerDefinitions.0.secrets.0.valueFrom",
        "arn:aws:secretsmanager:eu-west-1:123456789012:secret:cleanup-token");
    }
    if (provider === "azure") {
      expect(job.properties?.configuration).toMatchObject({ triggerType: "Schedule",replicaRetryLimit: 1,
        scheduleTriggerConfig: { cronExpression: "0 2 * * *",parallelism: 1,replicaCompletionCount: 1 } });
      expect(job.properties?.configuration.secrets).toHaveLength(1);
      expect(job.properties?.configuration.secrets[0]).toHaveProperty("name","cleanup-token");
    }
    if (provider === "gcp") expect(job.spec?.template.spec).toMatchObject({ parallelism: 1,taskCount: 1,
      template: { spec: { maxRetries: 1,timeoutSeconds: "900" } } });
  }
});

it("requires enabled uploads and a managed cleanup secret before writing a job",() => {
  for (const provider of providers) {
    expect(() => cleanupJob(provider,filledCloudManifest(provider),"fixture-cleanup")).toThrow("enable private uploads");
    const source = configured(provider);
    const app = provider === "aws" ? source.containerDefinitions[0] :
      provider === "azure" ? source.properties.template.containers[0] : source.spec.template.spec.containers[1];
    if (provider === "aws") app.secrets.pop();else app.env.pop();
    expect(() => cleanupJob(provider,source,"fixture-cleanup")).toThrow("CRON_SECRET must use a managed secret reference");
  }
  expect(() => cleanupJob("aws",configured("aws"),"invalid/name")).toThrow("job name");
});

it("keeps only Azure registry identity and a GCP secret alias needed by the cleanup job",() => {
  const azure = configured("azure");
  azure.properties.configuration.registries = [{ server: "registry.example",identity: "fixture-identity" }];
  expect(cleanupJob("azure",azure,"cleanup").properties?.configuration.registries).toEqual(azure.properties.configuration.registries);
  azure.properties.configuration.registries[0].passwordSecretRef = "registry-password";
  expect(() => cleanupJob("azure",azure,"cleanup")).toThrow("identity-based");

  const gcp = configured("gcp");
  gcp.spec.template.metadata.annotations["run.googleapis.com/secrets"] =
    "model-key:projects/fixture/secrets/model-key,cleanup-token:projects/fixture/secrets/cleanup-token";
  expect(cleanupJob("gcp",gcp,"cleanup").spec?.template.metadata?.annotations).toEqual({
    "run.googleapis.com/secrets": "cleanup-token:projects/fixture/secrets/cleanup-token",
  });
});

it("writes a private review artifact and refuses to overwrite it",async () => {
  const directory = await mkdtemp(join(tmpdir(),"cleanup-job-"));
  try {
    const input = join(directory,"runtime.json"),output = join(directory,"job.json");
    await writeFile(input,JSON.stringify(configured("azure")));
    const args = ["--import","tsx","scripts/create-cleanup-job.ts","--provider","azure","--file",input,
      "--name","fixture-cleanup","--output",output];
    await promisify(execFile)(process.execPath,args);
    expect((await stat(output)).mode & 0o777).toBe(0o600);
    const content = await readFile(output,"utf8");
    expect(JSON.parse(content).properties.configuration.triggerType).toBe("Schedule");
    await expect(promisify(execFile)(process.execPath,args)).rejects.toThrow("choose a new file");
    expect(await readFile(output,"utf8")).toBe(content);
  } finally { await rm(directory,{ recursive: true,force: true }); }
},15_000);
