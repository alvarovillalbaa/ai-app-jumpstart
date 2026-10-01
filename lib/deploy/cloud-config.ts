import { requestsPerMinute } from "../request-limits/settings";
import { awsS3Settings } from "../uploads/aws-s3";
import { remoteScannerSettings } from "../uploads/scanner";
export type CloudProvider = "aws" | "azure" | "gcp";
type JsonObject = Record<string,unknown>;

function fail(message: string): never { throw new Error(`Cloud manifest: ${message}`); }
function object(value: unknown,label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value as JsonObject;
}
function array(value: unknown,label: string): unknown[] {
  if (!Array.isArray(value)) fail(`${label} must be an array.`);
  return value;
}
function string(value: unknown,label: string): string {
  if (typeof value !== "string" || !value.trim()) fail(`${label} is missing.`);
  return value;
}
function child(value: unknown,key: string,label: string) { return object(object(value,label)[key],`${label}.${key}`); }
function named(items: unknown[],name: string,label: string) {
  const matches = items.map(item => object(item,label)).filter(item => item.name === name);
  if (matches.length !== 1) fail(`${label} must contain exactly one ${name}.`);
  return matches[0];
}
function envMap(entries: unknown[],label: string) {
  const map = new Map<string,JsonObject>();
  for (const item of entries) {
    const row = object(item,label),name = string(row.name,`${label}.name`);
    if (map.has(name)) fail(`${label} repeats ${name}.`);
    map.set(name,row);
  }
  return map;
}
function expectValue(env: Map<string,JsonObject>,name: string,value: string) {
  if (env.get(name)?.value !== value) fail(`${name} must be ${value}.`);
}
function requireSecret(env: Map<string,JsonObject>,name: string,provider: CloudProvider,
  secretNames: Set<string>,template: boolean) {
  const row = env.get(name);
  if (!row) fail(`${name} must use a managed secret reference.`);
  if (row.value !== undefined) fail(`${name} must not be a plaintext environment value.`);
  if (provider === "aws") {
    const ref = string(row.valueFrom,`${name} AWS secret reference`);
    if (!template && !/^arn:[^:]+:secretsmanager:[^:]+:\d{12}:secret:.+/.test(ref))
      fail(`${name} needs a Secrets Manager ARN.`);
  } else if (provider === "azure") {
    const ref = string(row.secretRef,`${name} secretRef`);
    if (!secretNames.has(ref)) fail(`${name} refers to an absent Key Vault secret.`);
  } else {
    const ref = child(row.valueFrom,"secretKeyRef",`${name}.valueFrom`);
    string(ref.name,`${name} secret name`);string(ref.key,`${name} secret version`);
  }
}
function digest(image: unknown,label: string,template: boolean) {
  const value = string(image,label);
  if (template && value.startsWith("REPLACE_WITH_")) return;
  if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(value)) fail(`${label} must pin an image sha256 digest.`);
}
function probe(container: JsonObject,kind: string,path: string,port: number,label: string) {
  const probes = array(container.probes,`${label}.probes`).map(item => object(item,`${label}.probe`));
  const matches = probes.filter(item => item.type === kind);
  if (matches.length !== 1) fail(`${label} needs one ${kind} probe.`);
  const http = child(matches[0],"httpGet",`${label}.${kind}`);
  if (http.path !== path || http.port !== port) fail(`${label} ${kind} probe must use ${path} on ${port}.`);
}

/** Read-only structural preflight. Cloud APIs and referenced secret values are not contacted. */
export function validateCloudManifest(provider: CloudProvider,raw: unknown,template = false) {
  const manifest = object(raw,"manifest");
  if (!template && JSON.stringify(raw).includes("REPLACE_")) fail("unresolved REPLACE_ marker remains.");
  let app: JsonObject,ingress: JsonObject | undefined,appEnv: Map<string,JsonObject>,ingressEnv: Map<string,JsonObject> | undefined;
  let secretNames = new Set<string>();
  if (provider === "aws") {
    const containers = array(manifest.containerDefinitions,"containerDefinitions");
    app = named(containers,"app","containerDefinitions");
    if (containers.length !== 1 || manifest.networkMode !== "awsvpc" ||
        !array(manifest.requiresCompatibilities,"requiresCompatibilities").includes("FARGATE"))
      fail("AWS must use one Fargate awsvpc app container.");
    if (app.essential !== true) fail("AWS app must be essential.");
    if (manifest.executionRoleArn === manifest.taskRoleArn) fail("AWS execution and task roles must differ.");
    string(manifest.executionRoleArn,"executionRoleArn");string(manifest.taskRoleArn,"taskRoleArn");
    if (!template && ![manifest.executionRoleArn,manifest.taskRoleArn].every(value =>
      typeof value === "string" && /^arn:[^:]+:iam::\d{12}:role\/.+/.test(value)))
      fail("AWS execution and task roles must be IAM role ARNs.");
    const mappings = array(app.portMappings,"app.portMappings").map(item => object(item,"app port"));
    if (mappings.length !== 2 || mappings.some(item => item.protocol !== "tcp") ||
        mappings.map(item => item.containerPort).sort().join(",") !== "3000,4274")
      fail("AWS app must expose only TCP ports 3000 and 4274 for ALB targets.");
    const health = child(app,"healthCheck","app");
    if (!JSON.stringify(health.command).includes("/api/health/ready"))
      fail("AWS app health check must include combined readiness.");
    appEnv = envMap([...array(app.environment,"app.environment"),...array(app.secrets,"app.secrets")],"app environment");
  } else if (provider === "azure") {
    const properties = child(manifest,"properties","manifest"),templateNode = child(properties,"template","properties");
    const configuration = child(properties,"configuration","properties");
    const containers = array(templateNode.containers,"template.containers");
    app = named(containers,"app","template.containers");ingress = named(containers,"ingress","template.containers");
    const publicIngress = child(configuration,"ingress","configuration");
    if (containers.length !== 2 || publicIngress.targetPort !== 8080 || publicIngress.external !== true ||
        publicIngress.allowInsecure !== false) fail("Azure ingress must expose HTTPS on port 8080.");
    const scale = child(templateNode,"scale","template");
    if (scale.minReplicas !== 1 || scale.maxReplicas !== 1) fail("Azure needs one dedicated replica until rollout is proven.");
    string(properties.workloadProfileName,"workloadProfileName");
    if (child(manifest,"identity","manifest").type !== "UserAssigned") fail("Azure needs a user-assigned identity.");
    probe(app,"Readiness","/api/health/ready",3000,"app");
    probe(ingress,"Readiness","/api/health/ready",8080,"ingress");
    secretNames = new Set(array(configuration.secrets,"configuration.secrets").map(item => {
      const secret = object(item,"configuration secret");
      const url = string(secret.keyVaultUrl,"Key Vault URL");string(secret.identity,"Key Vault identity");
      if (!template) {
        try { const parsed = new URL(url);if (parsed.protocol !== "https:" || !parsed.pathname.startsWith("/secrets/") ||
          parsed.pathname.split("/").filter(Boolean).length < 3 || parsed.username || parsed.password) throw new Error(); }
        catch { fail("Azure secrets need versioned HTTPS Key Vault URLs."); }
      }
      return string(secret.name,"configuration secret name");
    }));
    if (secretNames.size !== array(configuration.secrets,"configuration.secrets").length)
      fail("Azure secret names must be unique.");
    appEnv = envMap(array(app.env,"app.env"),"app environment");
    ingressEnv = envMap(array(ingress.env,"ingress.env"),"ingress environment");
  } else {
    const spec = child(child(child(manifest,"spec","manifest"),"template","spec"),"spec","template");
    string(spec.serviceAccountName,"Cloud Run serviceAccountName");
    const containers = array(spec.containers,"spec.containers");
    app = named(containers,"app","spec.containers");ingress = named(containers,"ingress","spec.containers");
    if (containers.length !== 2 || array(ingress.ports,"ingress.ports").length !== 1 ||
        object(array(ingress.ports,"ingress.ports")[0],"ingress port").containerPort !== 8080 || app.ports !== undefined)
      fail("only GCP ingress may expose port 8080.");
    const annotations = child(child(child(manifest,"spec","manifest"),"template","spec"),"metadata","template").annotations;
    const values = object(annotations,"template.annotations");
    if (values["run.googleapis.com/cpu-throttling"] !== "false" || values["autoscaling.knative.dev/minScale"] !== "1" ||
        values["autoscaling.knative.dev/maxScale"] !== "1") fail("Cloud Run needs one always-on instance with CPU allocation.");
    let dependencies: unknown;
    try { dependencies = JSON.parse(string(values["run.googleapis.com/container-dependencies"],"container dependencies")); }
    catch { fail("Cloud Run container dependencies are invalid."); }
    if (JSON.stringify(dependencies) !== JSON.stringify({ ingress: ["app"] })) fail("Cloud Run ingress must wait for app.");
    for (const [container,port,label] of [[app,3000,"app"],[ingress,8080,"ingress"]] as const) {
      for (const kind of ["startupProbe","readinessProbe"] as const) {
        const http = child(child(container,kind,label),"httpGet",`${label}.${kind}`);
        if (http.path !== "/api/health/ready" || http.port !== port)
          fail(`Cloud Run ${label} ${kind} must use combined readiness on port ${port}.`);
      }
    }
    appEnv = envMap(array(app.env,"app.env"),"app environment");
    ingressEnv = envMap(array(ingress.env,"ingress.env"),"ingress environment");
  }
  digest(app.image,"app image",template);
  if (ingress) digest(ingress.image,"ingress image",template);
  if (ingressEnv) {
    expectValue(ingressEnv,"NEXT_UPSTREAM","127.0.0.1:3000");
    expectValue(ingressEnv,"EVE_UPSTREAM","127.0.0.1:4274");
  }
  if (provider === "aws") expectValue(appEnv,"EVE_LISTEN_HOST","0.0.0.0");
  expectValue(appEnv,"AUTH_PROVIDER","supabase");
  if (!appEnv.has("APP_REQUESTS_PER_MINUTE")) fail("APP_REQUESTS_PER_MINUTE must be an explicit literal 0 or integer from 1 to 10000.");
  let requestLimitPerMinute: number;
  try { requestLimitPerMinute = requestsPerMinute({ APP_REQUESTS_PER_MINUTE: string(appEnv.get("APP_REQUESTS_PER_MINUTE")?.value,"APP_REQUESTS_PER_MINUTE") }); }
  catch { fail("APP_REQUESTS_PER_MINUTE must be a literal 0 or integer from 1 to 10000."); }
  expectValue(appEnv,"AI_CHAT_ENABLED","true");
  expectValue(appEnv,"APP_AGENT_READINESS","local");
  expectValue(appEnv,"AI_RUNTIME_ORIGIN","http://127.0.0.1:4274");
  expectValue(appEnv,"WORKFLOW_EXPECTED_PROVIDER","postgres");
  string(appEnv.get("WORKFLOW_POSTGRES_JOB_PREFIX")?.value,"WORKFLOW_POSTGRES_JOB_PREFIX");
  const origin = string(appEnv.get("APP_ORIGIN")?.value,"APP_ORIGIN");
  if (!template) {
    try { const url = new URL(origin);if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) throw new Error(); }
    catch { fail("APP_ORIGIN must be a public HTTPS origin."); }
  }
  const dataProvider = appEnv.get("DATA_PROVIDER")?.value;
  if (dataProvider !== "supabase" && dataProvider !== "postgres" && dataProvider !== "convex")
    fail("DATA_PROVIDER must be supabase, postgres or convex.");
  const uploadProvider = appEnv.get("UPLOAD_STORAGE_PROVIDER")?.value;
  if (appEnv.has("UPLOAD_STORAGE_PROVIDER") && uploadProvider !== "supabase" && uploadProvider !== "aws-s3")
    fail("Cloud uploads need private Supabase Storage or AWS S3; local volumes are not durable in these manifests.");
  if (uploadProvider === "aws-s3") {
    try { awsS3Settings({ UPLOAD_S3_REGION: appEnv.get("UPLOAD_S3_REGION")?.value as string | undefined,
      UPLOAD_S3_BUCKET: appEnv.get("UPLOAD_S3_BUCKET")?.value as string | undefined }); }
    catch { fail("AWS S3 uploads need valid literal UPLOAD_S3_REGION and UPLOAD_S3_BUCKET values."); }
  }
  const downloadPolicy = appEnv.get("UPLOAD_DOWNLOAD_POLICY")?.value;
  if (appEnv.has("UPLOAD_DOWNLOAD_POLICY") && downloadPolicy !== "off" && downloadPolicy !== "scan-on-read")
    fail("UPLOAD_DOWNLOAD_POLICY must be off or scan-on-read.");
  const agentUploadPolicy = appEnv.get("UPLOAD_AGENT_POLICY")?.value;
  if (appEnv.has("UPLOAD_AGENT_POLICY") && agentUploadPolicy !== "off" && agentUploadPolicy !== "reviewed-text")
    fail("UPLOAD_AGENT_POLICY must be off or reviewed-text.");
  if (agentUploadPolicy === "reviewed-text" && downloadPolicy !== "scan-on-read")
    fail("Reviewed agent uploads need scan-on-read downloads on the cloud app and worker.");
  const scannerConfigured = ["UPLOAD_SCANNER_PROVIDER","UPLOAD_SCANNER_URL","UPLOAD_SCANNER_TOKEN","UPLOAD_CLAMD_SOCKET"]
    .some(name => appEnv.has(name));
  if (scannerConfigured || downloadPolicy === "scan-on-read") {
    if (!uploadProvider) fail("Cloud upload scanning needs a configured private object backend.");
    if (!appEnv.has("UPLOAD_SCANNER_TOKEN")) fail("UPLOAD_SCANNER_TOKEN must use a managed secret reference.");
    try { remoteScannerSettings({ UPLOAD_SCANNER_PROVIDER: appEnv.get("UPLOAD_SCANNER_PROVIDER")?.value as string | undefined,
      UPLOAD_SCANNER_URL: appEnv.get("UPLOAD_SCANNER_URL")?.value as string | undefined,
      UPLOAD_SCANNER_TOKEN: "x".repeat(32),UPLOAD_CLAMD_SOCKET: appEnv.get("UPLOAD_CLAMD_SOCKET")?.value as string | undefined }); }
    catch { fail("Cloud upload scanning needs a remote provider and a valid literal HTTPS UPLOAD_SCANNER_URL."); }
  }
  const required = ["WORKFLOW_POSTGRES_URL","SUPABASE_AUTH_URL","SUPABASE_PUBLISHABLE_KEY",
    "AI_CREATION_SIGNING_JSON","AI_BUDGET_POLICY_JSON","AI_GATEWAY_API_KEY",
    ...(dataProvider === "supabase" ? ["SUPABASE_URL","SUPABASE_SECRET_KEY"] :
      dataProvider === "postgres" ? ["DATABASE_URL"] : ["CONVEX_SITE_URL","CONVEX_BACKEND_SECRET"]),
    ...(uploadProvider === "supabase" && dataProvider !== "supabase" ? ["SUPABASE_URL","SUPABASE_SECRET_KEY"] : []),
    ...(uploadProvider || appEnv.has("CRON_SECRET") ? ["CRON_SECRET"] : []),
    ...["APP_API_KEYS","UPLOAD_SCANNER_TOKEN","UPLOAD_DOWNLOAD_SIGNING_JSON"].filter(name => appEnv.has(name)),
    ...["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN"].filter(name => appEnv.has(name))];
  for (const name of ["WORKFLOW_POSTGRES_URL","SUPABASE_AUTH_URL","SUPABASE_PUBLISHABLE_KEY",
    "AI_CREATION_SIGNING_JSON","AI_BUDGET_POLICY_JSON","AI_GATEWAY_API_KEY",
    "SUPABASE_SECRET_KEY","DATABASE_URL","CONVEX_BACKEND_SECRET","CRON_SECRET","APP_API_KEYS","UPLOAD_SCANNER_TOKEN","UPLOAD_DOWNLOAD_SIGNING_JSON",
    "AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_SESSION_TOKEN"]) {
    if (appEnv.get(name)?.value !== undefined) fail(`${name} must not be a plaintext environment value.`);
  }
  for (const name of required) requireSecret(appEnv,name,provider,secretNames,template);
  return { provider,dataProvider,appOrigin: origin,secretReferences: required.length,requestLimitPerMinute };
}
