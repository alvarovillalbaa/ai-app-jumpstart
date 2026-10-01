import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { requireReplayRetention,workflowRunRetention } from "./workflow-retention.mjs";

export const workflowBuildMarker = join(".output", "jumpstart-workflow-provider");
export const workflowRetentionMarker = join(".output", "jumpstart-workflow-retention");

function provider(value) {
  if (value === "default" || value === "postgres") return value;
  throw new Error("Workflow provider must be default or postgres.");
}

/** @param {Record<string, string | undefined>} env */
export function writeWorkflowBuildMarker(env = process.env, path = workflowBuildMarker) {
  const selected = provider(env.EVE_WORKFLOW_PROVIDER ?? "default");
  const retention = requireReplayRetention(env);
  writeFileSync(path, `${selected}\n`, { flag: "w" });
  writeFileSync(join(dirname(path),"jumpstart-workflow-retention"),`${retention}\n`,{ flag: "w" });
  return selected;
}

/** Fail before serving if runtime configuration expects a different compiled world. */
/** @param {Record<string, string | undefined>} env */
export function verifyWorkflowBuild(env = process.env, path = workflowBuildMarker) {
  requireReplayRetention(env);
  const retention = workflowRunRetention(env.EVE_WORKFLOW_RETENTION ?? env.WORKFLOW_EXPECTED_RETENTION);
  const expectedRetention = env.WORKFLOW_EXPECTED_RETENTION === undefined ? retention : workflowRunRetention(env.WORKFLOW_EXPECTED_RETENTION);
  let compiledRetention = "default";
  try { compiledRetention = String(workflowRunRetention(readFileSync(join(dirname(path),"jumpstart-workflow-retention"),"utf8").trim())); }
  catch (error) {
    // Artifacts predating this option always used the native default.
    if (error?.code !== "ENOENT" || retention === 0 || expectedRetention === 0)
      throw new Error("Workflow retention marker is missing or invalid; rebuild the application.");
  }
  if (compiledRetention !== String(retention) || compiledRetention !== String(expectedRetention))
    throw new Error("Compiled Workflow retention differs from runtime settings; rebuild the application.");
  const expected = env.WORKFLOW_EXPECTED_PROVIDER === undefined
    ? undefined : provider(env.WORKFLOW_EXPECTED_PROVIDER);
  const requested = env.EVE_WORKFLOW_PROVIDER === undefined
    ? undefined : provider(env.EVE_WORKFLOW_PROVIDER);
  let built;
  try {
    built = provider(readFileSync(path, "utf8").trim());
  } catch (error) {
    if (expected || requested || env.WORKFLOW_POSTGRES_URL) {
      throw new Error("Workflow build marker is missing or invalid; rebuild the application for the expected provider.");
    }
    if (error?.code !== "ENOENT") throw new Error("Workflow build marker is invalid.");
    return undefined;
  }
  if ((expected && expected !== built) || (requested && requested !== built)) {
    throw new Error(`Workflow build is ${built}, but runtime expects ${expected ?? requested}. Rebuild the application.`);
  }
  if (built === "default" && env.WORKFLOW_POSTGRES_URL) {
    throw new Error("A PostgreSQL workflow URL cannot make a default-world build durable. Rebuild for postgres.");
  }
  if (built === "postgres" && !env.WORKFLOW_POSTGRES_URL) {
    throw new Error("The PostgreSQL workflow build requires WORKFLOW_POSTGRES_URL at runtime.");
  }
  return built;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "--write") {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  writeWorkflowBuildMarker();
}
