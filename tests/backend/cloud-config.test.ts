import { readFileSync } from "node:fs";
import { expect,it } from "vitest";
import { validateCloudManifest,type CloudProvider } from "../../lib/deploy/cloud-config";
import { filledCloudManifest } from "../helpers/cloud-manifest";

const files: Record<CloudProvider,string> = {
  aws: "deploy/aws/task-definition.example.json",
  azure: "deploy/azure/container-app.example.json",
  gcp: "deploy/gcp/service.example.json",
};
type FixtureEnv = { name: string;value?: string;secretRef?: string;valueFrom?: unknown };
type FixtureContainer = { name?: string;image: string;environment: FixtureEnv[];secrets: FixtureEnv[];env: FixtureEnv[];
  healthCheck: { command: string[] };startupProbe: { httpGet: { path: string;port: number } };
  portMappings?: { containerPort: number;protocol?: string }[];ports?: { containerPort: number }[] };
type FixtureManifest = { containerDefinitions: FixtureContainer[];
  identity?: { type: string; userAssignedIdentities?: Record<string,unknown> };
  properties: { configuration: { secrets: { name: string; keyVaultUrl: string; identity: string }[];
    registries?: { server: string; identity?: string; username?: string; passwordSecretRef?: string; password?: string }[] };
    template: { containers: FixtureContainer[] } };
  spec: { template: { spec: { serviceAccountName?: string;containers: FixtureContainer[] } } } };
const providers = Object.keys(files) as CloudProvider[];
const templates = Object.fromEntries(providers.map(provider => [provider,
  JSON.parse(readFileSync(files[provider],"utf8"))])) as Record<CloudProvider,FixtureManifest>;
function filled(provider: CloudProvider) {
  return filledCloudManifest(provider) as FixtureManifest;
}
function app(provider: CloudProvider,manifest: FixtureManifest) {
  return provider === "aws" ? manifest.containerDefinitions[0] :
    provider === "azure" ? manifest.properties.template.containers[0] : manifest.spec.template.spec.containers[1];
}

it("accepts the three authored templates and filled release-shaped manifests",() => {
  for (const provider of providers) {
    expect(validateCloudManifest(provider,templates[provider],true)).toMatchObject({ provider,dataProvider: "supabase" });
    expect(validateCloudManifest(provider,filled(provider))).toMatchObject({ provider,dataProvider: "supabase",secretReferences: 8,requestLimitPerMinute: 120 });
  }
});

it("requires a user-managed Cloud Run service identity email",() => {
  const valid = filled("gcp");
  expect(valid.spec.template.spec.serviceAccountName).toBe("jumpstart-runtime@fixture-project.iam.gserviceaccount.com");
  expect(validateCloudManifest("gcp",valid)).toMatchObject({ provider: "gcp" });

  for (const serviceAccountName of ["run@fixture-project.iam.gserviceaccount.com","x@fixture-project.iam.gserviceaccount.com",
    "123456789-compute@developer.gserviceaccount.com","not-an-email"]) {
    const invalid = filled("gcp");
    invalid.spec.template.spec.serviceAccountName = serviceAccountName;
    expect(() => validateCloudManifest("gcp",invalid)).toThrow("must be a user-managed IAM service account email");
  }
});

it("requires Cloud Run environment secrets to use latest or a pinned Secret Manager version",() => {
  const selectVersion = (manifest: FixtureManifest,key: string) => {
    const entry = manifest.spec.template.spec.containers.flatMap(container => container.env).find(row => row.name === "SUPABASE_URL");
    expect(entry).toBeDefined();
    (entry!.valueFrom as { secretKeyRef: { key: string } }).secretKeyRef.key = key;
  };
  const latest = filled("gcp");selectVersion(latest,"latest");
  expect(validateCloudManifest("gcp",latest)).toMatchObject({ provider: "gcp" });

  for (const key of ["0","-1","REPLACE_WITH_VERSION","named-version","1/versions/2"]) {
    const invalid = filled("gcp");selectVersion(invalid,key);
    expect(() => validateCloudManifest("gcp",invalid)).toThrow(key.startsWith("REPLACE_WITH_")
      ? "unresolved REPLACE_ marker" : "secret version must be latest or a positive version number");
  }
  expect(validateCloudManifest("gcp",templates.gcp,true)).toMatchObject({ provider: "gcp" });
});

it("requires Azure Key Vault secrets to use an identity attached to the app",() => {
  const valid = filled("azure");
  expect(validateCloudManifest("azure",valid)).toMatchObject({ provider: "azure" });

  const unattached = filled("azure");
  unattached.identity!.userAssignedIdentities = {};
  expect(() => validateCloudManifest("azure",unattached)).toThrow("needs an attached user-assigned identity");

  const multiple = filled("azure");
  const secondIdentity = "/subscriptions/fixture/other-identity";
  multiple.identity!.userAssignedIdentities![secondIdentity] = {};
  multiple.properties.configuration.secrets[0].identity = secondIdentity;
  expect(validateCloudManifest("azure",multiple)).toMatchObject({ provider: "azure" });

  const mismatch = filled("azure");
  mismatch.properties.configuration.secrets[0].identity = "/subscriptions/fixture/unattached-identity";
  expect(() => validateCloudManifest("azure",mismatch)).toThrow("must use an identity enabled on the app");
});

it("validates Azure registry pull identities against the identities enabled on the app",() => {
  const userAssigned = filled("azure");
  userAssigned.properties.configuration.registries = [{ server: "registry.example",identity: "fixture-identity" }];
  expect(validateCloudManifest("azure",userAssigned)).toMatchObject({ provider: "azure" });

  const hybrid = filled("azure");
  hybrid.identity!.type = "SystemAssigned, UserAssigned";
  hybrid.properties.configuration.registries = [{ server: "registry.example",identity: "system" }];
  expect(validateCloudManifest("azure",hybrid)).toMatchObject({ provider: "azure" });

  const systemOnly = filled("azure");
  systemOnly.identity = { type: "SystemAssigned" };
  for (const secret of systemOnly.properties.configuration.secrets) secret.identity = "system";
  systemOnly.properties.configuration.registries = [{ server: "registry.example",identity: "system" }];
  expect(validateCloudManifest("azure",systemOnly)).toMatchObject({ provider: "azure" });

  const unattached = filled("azure");
  unattached.properties.configuration.registries = [{ server: "registry.example",identity: "/subscriptions/fixture/unattached-identity" }];
  expect(() => validateCloudManifest("azure",unattached)).toThrow("registry identity must be enabled on the app");

  const systemWithoutIdentity = filled("azure");
  systemWithoutIdentity.properties.configuration.registries = [{ server: "registry.example",identity: "system" }];
  expect(() => validateCloudManifest("azure",systemWithoutIdentity)).toThrow("registry identity must be enabled on the app");
});

it("requires Azure registry credentials to reference a declared Key Vault secret without mixing auth modes",() => {
  const credentials = filled("azure");
  credentials.properties.configuration.secrets.push({ name: "registry-password",
    keyVaultUrl: "https://fixture.vault.azure.net/secrets/registry-password/version1",identity: "fixture-identity" });
  credentials.properties.configuration.registries = [{ server: "registry.example",username: "fixture-user",
    passwordSecretRef: "registry-password" }];
  expect(validateCloudManifest("azure",credentials)).toMatchObject({ provider: "azure" });

  const missingSecret = filled("azure");
  missingSecret.properties.configuration.registries = [{ server: "registry.example",username: "fixture-user",
    passwordSecretRef: "unlisted-secret" }];
  expect(() => validateCloudManifest("azure",missingSecret)).toThrow("passwordSecretRef must name a declared Key Vault secret");

  const mixed = filled("azure");
  mixed.properties.configuration.registries = [{ server: "registry.example",identity: "fixture-identity",
    username: "fixture-user",passwordSecretRef: "model-key" }];
  expect(() => validateCloudManifest("azure",mixed)).toThrow("must not be combined");

  const plaintext = filled("azure");
  plaintext.properties.configuration.registries = [{ server: "registry.example",password: "private-password" }];
  try { validateCloudManifest("azure",plaintext);throw new Error("Expected rejection."); }
  catch (error) { expect(String(error)).toContain("passwords must use a secret reference");expect(String(error)).not.toContain("private-password"); }
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

it("requires private object settings when cloud uploads are enabled",() => {
  for (const provider of providers) {
    const manifest = filled(provider),application = app(provider,manifest);
    const literals = provider === "aws" ? application.environment : application.env;
    const secrets = provider === "aws" ? application.secrets : application.env;
    const storage = { name: "UPLOAD_STORAGE_PROVIDER",value: "local" };
    literals.push(storage);
    expect(() => validateCloudManifest(provider,manifest)).toThrow("local volumes are not durable");

    storage.value = "supabase";
    expect(() => validateCloudManifest(provider,manifest)).toThrow("CRON_SECRET must use a managed secret reference");
    const cronReference = { ...(provider === "aws" ? application.secrets : application.env)
      .find(row => row.name === "AI_GATEWAY_API_KEY")!,name: "CRON_SECRET" };
    secrets.push(cronReference);
    expect(validateCloudManifest(provider,manifest)).toMatchObject({ secretReferences: 9 });
    literals.find(row => row.name === "DATA_PROVIDER")!.value = "postgres";
    secrets.find(row => row.name === "SUPABASE_URL")!.name = "DATABASE_URL";
    expect(() => validateCloudManifest(provider,manifest)).toThrow("SUPABASE_URL must use a managed secret reference");
    const secret = secrets.find(row => row.name === "SUPABASE_SECRET_KEY")!;
    secrets.push({ ...secret,name: "SUPABASE_URL" });
    expect(() => validateCloudManifest(provider,manifest)).not.toThrow();
    delete cronReference.secretRef;delete cronReference.valueFrom;cronReference.value = "private-cron-secret-value";
    expect(() => validateCloudManifest(provider,manifest)).toThrow("CRON_SECRET must not be a plaintext");
    delete cronReference.value;Object.assign(cronReference,{ ...secrets.find(row => row.name === "AI_GATEWAY_API_KEY")!,name: "CRON_SECRET" });
    delete secret.secretRef;delete secret.valueFrom;secret.value = "private-storage-key";
    expect(() => validateCloudManifest(provider,manifest)).toThrow("SUPABASE_SECRET_KEY must not be a plaintext");
  }
});

it("checks S3 bucket settings and refuses plaintext AWS credentials",() => {
  for (const provider of providers) {
    const manifest = filled(provider),application = app(provider,manifest);
    const literals = provider === "aws" ? application.environment : application.env;
    literals.push({ name: "UPLOAD_STORAGE_PROVIDER",value: "aws-s3" });
    expect(() => validateCloudManifest(provider,manifest)).toThrow("UPLOAD_S3_REGION and UPLOAD_S3_BUCKET");
    literals.push({ name: "UPLOAD_S3_REGION",value: "eu-west-1" },{ name: "UPLOAD_S3_BUCKET",value: "private-upload-fixture" });
    expect(() => validateCloudManifest(provider,manifest)).toThrow("CRON_SECRET must use a managed secret reference");
    const secrets = provider === "aws" ? application.secrets : application.env;
    secrets.push({ ...secrets.find(row => row.name === "AI_GATEWAY_API_KEY")!,name: "CRON_SECRET" });
    expect(() => validateCloudManifest(provider,manifest)).not.toThrow();
    literals.push({ name: "AWS_SECRET_ACCESS_KEY",value: "private-aws-key" });
    try { validateCloudManifest(provider,manifest);throw new Error("Expected rejection."); }
    catch (error) { expect(String(error)).toContain("plaintext");expect(String(error)).not.toContain("private-aws-key"); }
    literals.pop();
    secrets.push({ ...secrets.find(row => row.name === "AI_GATEWAY_API_KEY")!,name: "AWS_SECRET_ACCESS_KEY" });
    expect(validateCloudManifest(provider,manifest)).toMatchObject({ secretReferences: 10 });
  }
});

it("requires a canonical literal request limit and permits explicit disabling",() => {
  for (const provider of providers) {
    const manifest = filled(provider),application = app(provider,manifest);
    const values = provider === "aws" ? application.environment : application.env;
    const row = values.find(item => item.name === "APP_REQUESTS_PER_MINUTE")!;
    row.value = "0";expect(validateCloudManifest(provider,manifest)).toMatchObject({ requestLimitPerMinute: 0 });
    for (const value of ["-1","1.5","10001","01", "private-quota-value"]) {
      row.value = value;
      try { validateCloudManifest(provider,manifest);throw new Error("Expected rejection."); }
      catch (error) { expect(String(error)).toContain("APP_REQUESTS_PER_MINUTE");expect(String(error)).not.toContain(value); }
    }
    values.splice(values.indexOf(row),1);expect(() => validateCloudManifest(provider,manifest)).toThrow("APP_REQUESTS_PER_MINUTE");
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

it("keeps optional API-key digests in managed secret references",() => {
  for (const provider of providers) {
    const manifest = filled(provider),application = app(provider,manifest);
    const literals = provider === "aws" ? application.environment : application.env;
    const secrets = provider === "aws" ? application.secrets : application.env;
    literals.push({ name: "APP_API_KEYS",value: "private-account-key-digests" });
    try { validateCloudManifest(provider,manifest);throw new Error("Expected rejection."); }
    catch (error) { expect(String(error)).toContain("APP_API_KEYS must not be a plaintext");expect(String(error)).not.toContain("private-account-key-digests"); }
    literals.pop();
    secrets.push({ ...secrets.find(row => row.name === "AI_GATEWAY_API_KEY")!,name: "APP_API_KEYS" });
    expect(validateCloudManifest(provider,manifest)).toMatchObject({ secretReferences: 9 });
    secrets.push({ ...secrets.find(row => row.name === "AI_GATEWAY_API_KEY")!,name: "CRON_SECRET" });
    expect(validateCloudManifest(provider,manifest)).toMatchObject({ secretReferences: 10 });
  }
});

it("requires a declared remote scanner and managed token for cloud scan-on-read",() => {
  for (const provider of providers) {
    const manifest = filled(provider),application = app(provider,manifest);
    const literals = provider === "aws" ? application.environment : application.env;
    const secrets = provider === "aws" ? application.secrets : application.env;
    literals.push({ name: "UPLOAD_STORAGE_PROVIDER",value: "supabase" },{ name: "UPLOAD_DOWNLOAD_POLICY",value: "scan-on-read" });
    secrets.push({ ...secrets.find(row => row.name === "AI_GATEWAY_API_KEY")!,name: "CRON_SECRET" });
    expect(() => validateCloudManifest(provider,manifest)).toThrow("UPLOAD_SCANNER_TOKEN must use a managed secret reference");
    literals.push({ name: "UPLOAD_SCANNER_PROVIDER",value: "remote" },
      { name: "UPLOAD_SCANNER_URL",value: "https://scanner.example.org/v1/scan" });
    const token = { ...secrets.find(row => row.name === "AI_GATEWAY_API_KEY")!,name: "UPLOAD_SCANNER_TOKEN" };
    secrets.push(token);
    expect(validateCloudManifest(provider,manifest)).toMatchObject({ secretReferences: 10 });
    literals.push({ name: "UPLOAD_AGENT_POLICY",value: "reviewed-text" });
    expect(() => validateCloudManifest(provider,manifest)).not.toThrow();
    literals.find(row => row.name === "UPLOAD_DOWNLOAD_POLICY")!.value = "off";
    expect(() => validateCloudManifest(provider,manifest)).toThrow("Reviewed agent uploads need scan-on-read");
    literals.find(row => row.name === "UPLOAD_DOWNLOAD_POLICY")!.value = "scan-on-read";
    literals.find(row => row.name === "UPLOAD_SCANNER_URL")!.value = "http://scanner.example.org/v1/scan";
    expect(() => validateCloudManifest(provider,manifest)).toThrow("valid literal HTTPS UPLOAD_SCANNER_URL");
    literals.find(row => row.name === "UPLOAD_SCANNER_URL")!.value = "https://scanner.example.org/v1/scan";
    delete token.secretRef;delete token.valueFrom;token.value = "private-scanner-token-value";
    try { validateCloudManifest(provider,manifest);throw new Error("Expected rejection."); }
    catch (error) { expect(String(error)).toContain("UPLOAD_SCANNER_TOKEN must not be a plaintext");expect(String(error)).not.toContain("private-scanner-token-value"); }
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
  const aws = filled("aws");aws.containerDefinitions[0].portMappings = [
    { containerPort: 3000,protocol: "tcp" },{ containerPort: 8080,protocol: "tcp" },
  ];
  expect(() => validateCloudManifest("aws",aws)).toThrow("only TCP ports 3000 and 4274");
  const awsWithSidecar = filled("aws");(awsWithSidecar.containerDefinitions as unknown[]).push({ name: "ingress" });
  expect(() => validateCloudManifest("aws",awsWithSidecar)).toThrow("one Fargate awsvpc app container");
  const gcp = filled("gcp");gcp.spec.template.spec.containers[1].ports = [{ containerPort: 3000 }];
  expect(() => validateCloudManifest("gcp",gcp)).toThrow("only GCP ingress");
});

it("keeps AWS task ports, Eve bind address and ALB path routing aligned",() => {
  const task = filled("aws").containerDefinitions[0];
  expect(task.portMappings).toEqual([
    { containerPort: 3000,protocol: "tcp" },{ containerPort: 4274,protocol: "tcp" },
  ]);
  expect(task.environment.find(row => row.name === "EVE_LISTEN_HOST")?.value).toBe("0.0.0.0");

  const template = JSON.parse(readFileSync("deploy/aws/alb-routing.example.json","utf8")) as {
    Parameters: { SslPolicy: { Default: string } };
    Resources: {
      NextTargetGroup: { Type: string;Properties: { Port: number;TargetType: string;HealthCheckPath: string } };
      EveTargetGroup: { Type: string;Properties: { Port: number;TargetType: string;HealthCheckPath: string } };
      HttpsListener: { Properties: { SslPolicy: { Ref: string };DefaultActions: unknown[] } };
      EveListenerRule: { Properties: { Conditions: unknown[];Actions: unknown[] } };
    };
  };
  const { NextTargetGroup, EveTargetGroup, HttpsListener, EveListenerRule } = template.Resources;
  expect(template.Parameters.SslPolicy.Default).toBe("ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09");
  expect(NextTargetGroup).toMatchObject({ Type: "AWS::ElasticLoadBalancingV2::TargetGroup",Properties: {
    Port: 3000,TargetType: "ip",HealthCheckPath: "/api/health/ready",
  } });
  expect(EveTargetGroup).toMatchObject({ Type: "AWS::ElasticLoadBalancingV2::TargetGroup",Properties: {
    Port: 4274,TargetType: "ip",HealthCheckPath: "/eve/v1/health",
  } });
  expect(HttpsListener.Properties.SslPolicy.Ref).toBe("SslPolicy");
  expect(HttpsListener.Properties.DefaultActions).toEqual([
    { Type: "forward",TargetGroupArn: { Ref: "NextTargetGroup" } },
  ]);
  expect(EveListenerRule.Properties).toMatchObject({
    Conditions: [{ Field: "path-pattern",PathPatternConfig: { Values: ["/eve/*","/.well-known/workflow/*"] } }],
    Actions: [{ Type: "forward",TargetGroupArn: { Ref: "EveTargetGroup" } }],
  });
});
