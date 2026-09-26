import { readFileSync } from "node:fs";
import { expect,it } from "vitest";
import { validateCloudManifest,type CloudProvider } from "../../lib/deploy/cloud-config";

const files: Record<CloudProvider,string> = {
  aws: "deploy/aws/task-definition.example.json",
  azure: "deploy/azure/container-app.example.json",
  gcp: "deploy/gcp/service.example.json",
};
type FixtureEnv = { name: string;value?: string;secretRef?: string;valueFrom?: unknown };
type FixtureContainer = { image: string;environment: FixtureEnv[];secrets: FixtureEnv[];env: FixtureEnv[];
  healthCheck: { command: string[] };startupProbe: { httpGet: { path: string;port: number } };
  portMappings?: { containerPort: number }[];ports?: { containerPort: number }[] };
type FixtureManifest = { containerDefinitions: FixtureContainer[];
  properties: { template: { containers: FixtureContainer[] } };
  spec: { template: { spec: { containers: FixtureContainer[] } } } };
const providers = Object.keys(files) as CloudProvider[];
const templates = Object.fromEntries(providers.map(provider => [provider,
  JSON.parse(readFileSync(files[provider],"utf8"))])) as Record<CloudProvider,FixtureManifest>;
function filled(provider: CloudProvider) {
  const text = JSON.stringify(templates[provider])
    .replaceAll("REPLACE_WITH_POSTGRES_WORKFLOW_IMAGE_AT_SHA256_DIGEST",`registry.example/app@sha256:${"a".repeat(64)}`)
    .replaceAll("REPLACE_WITH_INGRESS_IMAGE_AT_SHA256_DIGEST",`registry.example/ingress@sha256:${"b".repeat(64)}`)
    .replaceAll("REPLACE_WITH_EXECUTION_ROLE_ARN","arn:aws:iam::123456789012:role/fixture-execution")
    .replaceAll("REPLACE_WITH_TASK_ROLE_ARN","arn:aws:iam::123456789012:role/fixture-task")
    .replace(/REPLACE_WITH_[A-Z0-9_]+_SECRET_ARN/g,"arn:aws:secretsmanager:eu-west-1:123456789012:secret:fixture")
    .replace(/REPLACE_[A-Z0-9_]+/g,"fixture");
  return JSON.parse(text) as FixtureManifest;
}
function app(provider: CloudProvider,manifest: FixtureManifest) {
  return provider === "aws" ? manifest.containerDefinitions[0] :
    provider === "azure" ? manifest.properties.template.containers[0] : manifest.spec.template.spec.containers[1];
}

it("accepts the three authored templates and filled release-shaped manifests",() => {
  for (const provider of providers) {
    expect(validateCloudManifest(provider,templates[provider],true)).toMatchObject({ provider,dataProvider: "supabase" });
    expect(validateCloudManifest(provider,filled(provider))).toMatchObject({ provider,dataProvider: "supabase",secretReferences: 8 });
  }
});

it("accepts PostgreSQL and Convex application data with unchanged Supabase identity",() => {
  for (const provider of providers) for (const dataProvider of ["postgres","convex"] as const) {
    const manifest = filled(provider),application = app(provider,manifest);
    const values = provider === "aws" ? application.environment : application.env;
    values.find(row => row.name === "DATA_PROVIDER")!.value = dataProvider;
    const secrets = provider === "aws" ? application.secrets : application.env;
    secrets.find(row => row.name === "SUPABASE_URL")!.name = dataProvider === "postgres" ? "DATABASE_URL" : "CONVEX_SITE_URL";
    if (dataProvider === "postgres") {
      const index = secrets.findIndex(row => row.name === "SUPABASE_SECRET_KEY");
      secrets.splice(index,1);
    } else secrets.find(row => row.name === "SUPABASE_SECRET_KEY")!.name = "CONVEX_BACKEND_SECRET";
    expect(validateCloudManifest(provider,manifest)).toMatchObject({ provider,dataProvider });
  }
});

it("requires a managed secret reference for the optional upload download keyring",() => {
  for (const provider of providers) {
    const manifest = filled(provider),application = app(provider,manifest);
    const values = provider === "aws" ? application.secrets : application.env;
    const reference = values.find(row => row.name === "AI_CREATION_SIGNING_JSON")!;
    values.push({ ...reference,name: "UPLOAD_DOWNLOAD_SIGNING_JSON" });
    expect(validateCloudManifest(provider,manifest)).toMatchObject({ secretReferences: 9 });
    const row = values.find(item => item.name === "UPLOAD_DOWNLOAD_SIGNING_JSON")!;
    delete row.secretRef;delete row.valueFrom;row.value = "private-upload-keyring-value";
    try { validateCloudManifest(provider,manifest);throw new Error("Expected rejection."); }
    catch (error) { expect(String(error)).toContain("plaintext");expect(String(error)).not.toContain("private-upload-keyring-value"); }
  }
});

it("rejects unresolved markers, mutable image tags and missing combined readiness",() => {
  for (const provider of providers) {
    expect(() => validateCloudManifest(provider,templates[provider])).toThrow("unresolved REPLACE_");
    const tagged = filled(provider);
    app(provider,tagged).image = "registry.example/app:latest";
    expect(() => validateCloudManifest(provider,tagged)).toThrow("sha256 digest");
  }
  const aws = filled("aws");
  aws.containerDefinitions[0].healthCheck.command[3] = "fetch('http://127.0.0.1:3000/api/health/live')";
  expect(() => validateCloudManifest("aws",aws)).toThrow("combined readiness");
  const gcp = filled("gcp");
  gcp.spec.template.spec.containers[1].startupProbe.httpGet.path = "/api/health/live";
  expect(() => validateCloudManifest("gcp",gcp)).toThrow("combined readiness");
  const wrongPort = filled("gcp");
  wrongPort.spec.template.spec.containers[1].startupProbe.httpGet.port = 8080;
  expect(() => validateCloudManifest("gcp",wrongPort)).toThrow("port 3000");
  const azure = filled("azure");azure.properties.template.containers[0].image = "registry.example/app:latest";
  expect(() => validateCloudManifest("azure",azure)).toThrow("sha256 digest");
});

it("rejects plaintext secrets and public app/Eve ports without echoing a secret",() => {
  for (const provider of providers) {
    const manifest = filled(provider),application = app(provider,manifest);
    if (provider === "aws") {
      application.environment.push({ name: "AI_BUDGET_POLICY_JSON",value: "private-fixture-value" });
      application.secrets = application.secrets.filter(row => row.name !== "AI_BUDGET_POLICY_JSON");
    } else if (provider === "azure") {
      const row = application.env.find(item => item.name === "AI_BUDGET_POLICY_JSON")!;
      delete row.secretRef;row.value = "private-fixture-value";
    } else {
      const row = application.env.find(item => item.name === "AI_BUDGET_POLICY_JSON")!;
      delete row.valueFrom;row.value = "private-fixture-value";
    }
    try { validateCloudManifest(provider,manifest);throw new Error("Expected rejection."); }
    catch (error) {
      expect(String(error)).toContain("plaintext");
      expect(String(error)).not.toContain("private-fixture-value");
    }
  }
  const aws = filled("aws");aws.containerDefinitions[0].portMappings = [{ containerPort: 4274 }];
  expect(() => validateCloudManifest("aws",aws)).toThrow("only ingress");
  const gcp = filled("gcp");gcp.spec.template.spec.containers[1].ports = [{ containerPort: 3000 }];
  expect(() => validateCloudManifest("gcp",gcp)).toThrow("only GCP ingress");
});
