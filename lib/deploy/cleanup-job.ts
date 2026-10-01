import { validateCloudManifest, type CloudProvider } from "./cloud-config";

type JsonObject = Record<string, unknown>;
const object = (value: unknown) => value as JsonObject;
function fail(message: string): never { throw new Error(`Cleanup job: ${message}`); }

/** Derives a one-container scheduled cleanup job from a reviewed runtime release. */
export function cleanupJob(provider: CloudProvider, input: unknown, name: string) {
  if (!/^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name)) fail("use a lowercase job name of at most 32 characters.");
  validateCloudManifest(provider, input);
  const source = object(structuredClone(input));
  let app: JsonObject, configuration: JsonObject | undefined;
  if (provider === "aws") {
    app = (source.containerDefinitions as JsonObject[]).find(row => row.name === "app")!;
  } else if (provider === "azure") {
    const properties = object(source.properties);
    configuration = object(properties.configuration);
    app = (object(properties.template).containers as JsonObject[]).find(row => row.name === "app")!;
  } else {
    app = (object(object(object(source.spec).template).spec).containers as JsonObject[]).find(row => row.name === "app")!;
  }
  const literalEnv = (provider === "aws" ? app.environment : app.env) as JsonObject[];
  if (!literalEnv.some(row => row.name === "UPLOAD_STORAGE_PROVIDER")) fail("enable private uploads before scheduling cleanup.");
  const origin = literalEnv.find(row => row.name === "APP_ORIGIN")!;
  const secretEnv = (provider === "aws" ? app.secrets : app.env) as JsonObject[];
  const cron = secretEnv.find(row => row.name === "CRON_SECRET")!;
  const env = [origin, cron];
  const args = ["scripts/run-upload-cleanup.mjs"];

  if (provider === "aws") {
    return {
      family: name, networkMode: source.networkMode, requiresCompatibilities: source.requiresCompatibilities,
      cpu: source.cpu, memory: source.memory, executionRoleArn: source.executionRoleArn,
      runtimePlatform: source.runtimePlatform,
      containerDefinitions: [{ name: "cleanup", image: app.image, essential: true, user: app.user,
        stopTimeout: app.stopTimeout, entryPoint: ["node"], command: args,
        environment: [origin], secrets: [cron], logConfiguration: app.logConfiguration }],
    };
  }
  if (provider === "azure") {
    const properties = object(source.properties);
    const secrets = (configuration!.secrets as JsonObject[]).filter(row => row.name === cron.secretRef);
    const registries = configuration!.registries as JsonObject[] | undefined;
    if (registries?.some(row => row.passwordSecretRef || row.username || !row.identity))
      fail("use identity-based Azure registry access for generated jobs.");
    return { name, location: source.location, identity: source.identity, properties: {
      environmentId: properties.environmentId, workloadProfileName: properties.workloadProfileName,
      configuration: { triggerType: "Schedule", replicaTimeout: 900, replicaRetryLimit: 1,
        scheduleTriggerConfig: { cronExpression: "0 2 * * *", parallelism: 1, replicaCompletionCount: 1 },
        secrets, ...(registries ? { registries } : {}) },
      template: { containers: [{ name: "cleanup", image: app.image, resources: app.resources,
        command: ["node"], args, env }] },
    } };
  }
  const spec = object(object(object(source.spec).template).spec);
  const annotations = object(object(object(source.spec).template).metadata).annotations as JsonObject;
  const aliases = annotations["run.googleapis.com/secrets"];
  if (aliases !== undefined && typeof aliases !== "string") fail("invalid GCP secret aliases.");
  const secretName = object(object(cron.valueFrom).secretKeyRef).name;
  const selectedAliases = typeof aliases === "string" ? aliases.split(",").map(alias => alias.trim())
    .filter(alias => alias.startsWith(`${secretName}:`)) : [];
  if (selectedAliases.length > 1) fail("duplicate GCP cleanup secret alias.");
  const secretAlias = selectedAliases[0];
  const metadata = object(source.metadata);
  return { apiVersion: "run.googleapis.com/v1", kind: "Job",
    metadata: { name, ...(metadata.namespace ? { namespace: metadata.namespace } : {}) },
    spec: { template: { ...(secretAlias ? { metadata: { annotations: { "run.googleapis.com/secrets": secretAlias } } } : {}),
      spec: { parallelism: 1, taskCount: 1,
      template: { spec: { maxRetries: 1, timeoutSeconds: "900", serviceAccountName: spec.serviceAccountName,
        containers: [{ name: "cleanup", image: app.image, resources: app.resources,
          command: ["node"], args, env }] } } } } } };
}
