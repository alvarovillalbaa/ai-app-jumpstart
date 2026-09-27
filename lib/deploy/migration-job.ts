import { validateCloudManifest, type CloudProvider } from "./cloud-config";

export type MigrationOperation = "application-preview" | "application-apply" | "workflow-apply";
type ObjectValue = Record<string, unknown>;
const object = (value: unknown) => value as ObjectValue;
function fail(message: string): never { throw new Error(`Migration job: ${message}`); }
function record(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid secret reference.");
  return object(value);
}
function only(row: ObjectValue, keys: string[]) {
  if (Object.keys(row).some(key => !keys.includes(key))) fail("unexpected secret reference field.");
}

/** References only; never accepts a connection string or inline credential. */
function databaseReference(provider: CloudProvider, input: unknown) {
  const row = record(input);
  if (provider === "azure") {
    only(row, ["name", "keyVaultUrl", "identity"]);
    if (typeof row.name !== "string" || !/^[a-z0-9-]{1,32}$/.test(row.name) ||
        typeof row.identity !== "string" || !row.identity.trim()) fail("invalid Key Vault reference.");
    try {
      const url = new URL(String(row.keyVaultUrl));
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
          !/^\/secrets\/[^/]+\/[^/]+$/.test(url.pathname)) throw new Error();
    } catch { fail("application database needs a versioned HTTPS Key Vault reference."); }
    return { env: { name: "DATABASE_URL", secretRef: row.name }, secret: row };
  }
  only(row, ["name", "valueFrom"]);
  if (row.name !== "DATABASE_URL") fail("application database reference must name DATABASE_URL.");
  if (provider === "aws") {
    if (typeof row.valueFrom !== "string" || !/^arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:.+/.test(row.valueFrom))
      fail("application database needs a Secrets Manager ARN.");
  } else {
    const from = record(row.valueFrom); only(from, ["secretKeyRef"]);
    const key = record(from.secretKeyRef); only(key, ["name", "key"]);
    if (typeof key.name !== "string" || !key.name.trim() || typeof key.key !== "string" || !/^[1-9]\d*$/.test(key.key))
      fail("application database needs a numbered Secret Manager version.");
  }
  return { env: row, secret: undefined };
}

/** Produces a reviewable one-off job, without calling a cloud API or database. */
export function migrationJob(provider: CloudProvider, input: unknown, operation: MigrationOperation,
  name: string, databaseSecret?: unknown) {
  if (!/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name)) fail("use a lowercase job name of at most 32 characters.");
  if (!["application-preview", "application-apply", "workflow-apply"].includes(operation)) fail("unknown operation.");
  validateCloudManifest(provider, input);
  // Work on a copy so producing one job never changes the runtime release input.
  const source = object(structuredClone(input));
  const workflow = operation === "workflow-apply";
  if (workflow && databaseSecret !== undefined) fail("Workflow jobs do not accept an application database reference.");
  const database = workflow ? undefined : databaseReference(provider, databaseSecret);
  const args = workflow ? ["scripts/migrate-workflow.mjs"] :
    ["scripts/migrate.ts", ...(operation === "application-preview" ? ["--dry-run"] : [])];
  let containers: ObjectValue[], configuration: ObjectValue | undefined;
  if (provider === "aws") containers = source.containerDefinitions as ObjectValue[];
  else if (provider === "azure") {
    const properties = object(source.properties);
    configuration = object(properties.configuration);
    containers = object(properties.template).containers as ObjectValue[];
  } else containers = object(object(object(source.spec).template).spec).containers as ObjectValue[];
  const app = containers.find(row => row.name === "app")!;
  const env = (provider === "aws" ? [...app.environment as ObjectValue[], ...app.secrets as ObjectValue[]] : app.env) as ObjectValue[];
  const jobEnv: ObjectValue[] = workflow ? env.filter(row => ["WORKFLOW_POSTGRES_URL", "WORKFLOW_POSTGRES_JOB_PREFIX"].includes(String(row.name))) : [database!.env];

  if (provider === "aws") {
    return {
      family: name, networkMode: source.networkMode, requiresCompatibilities: source.requiresCompatibilities,
      cpu: source.cpu, memory: source.memory, executionRoleArn: source.executionRoleArn,
      taskRoleArn: source.taskRoleArn, runtimePlatform: source.runtimePlatform,
      containerDefinitions: [{ name: "migrate", image: app.image, essential: true, user: app.user,
        stopTimeout: app.stopTimeout, entryPoint: ["node"], command: args,
        environment: jobEnv.filter(row => row.value !== undefined), secrets: jobEnv.filter(row => row.value === undefined),
        logConfiguration: app.logConfiguration }],
    };
  }
  if (provider === "azure") {
    const properties = object(source.properties);
    const secrets = workflow ? (configuration!.secrets as ObjectValue[]).filter(row =>
      jobEnv.some(entry => entry.secretRef === row.name)) : [database!.secret];
    for (const secret of secrets) only(record(secret), ["name", "keyVaultUrl", "identity"]);
    // Registry authentication is identity-based. Credential-bearing registry
    // entries need their own reviewed job definition, rather than copying secrets.
    const registries = configuration!.registries as ObjectValue[] | undefined;
    if (registries?.some(row => row.passwordSecretRef || row.username || !row.identity))
      fail("use identity-based Azure registry access for generated jobs.");
    return { name, location: source.location, identity: source.identity, properties: {
      environmentId: properties.environmentId, workloadProfileName: properties.workloadProfileName,
      configuration: { triggerType: "Manual", replicaTimeout: 300, replicaRetryLimit: 0,
        manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }, secrets,
        ...(registries ? { registries } : {}) },
      template: { containers: [{ name: "migrate", image: app.image, resources: app.resources,
        command: ["node"], args, env: jobEnv }] },
    } };
  }
  const template = object(object(source.spec).template), spec = object(template.spec);
  const annotations = object(object(template.metadata).annotations);
  const retained = Object.fromEntries(Object.entries(annotations).filter(([key]) => [
    "run.googleapis.com/cloudsql-instances", "run.googleapis.com/vpc-access-connector",
    "run.googleapis.com/vpc-access-egress", "run.googleapis.com/network-interfaces",
    "run.googleapis.com/encryption-key", "run.googleapis.com/secrets",
  ].includes(key)));
  const metadata = object(source.metadata);
  return { apiVersion: "run.googleapis.com/v1", kind: "Job",
    metadata: { name, ...(metadata.namespace ? { namespace: metadata.namespace } : {}) },
    spec: { template: { metadata: { annotations: retained }, spec: { parallelism: 1, taskCount: 1,
      template: { spec: { maxRetries: 0, timeoutSeconds: "300", serviceAccountName: spec.serviceAccountName,
        containers: [{ name: "migrate", image: app.image, resources: app.resources,
          command: ["node"], args, env: jobEnv }] } } } } } };
}
