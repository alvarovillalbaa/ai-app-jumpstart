import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const workflowBuildMarker = join(".output", "jumpstart-workflow-provider");

function provider(value) {
  if (value === "default" || value === "postgres") return value;
  throw new Error("Workflow provider must be default or postgres.");
}

/** @param {Record<string, string | undefined>} env */
export function writeWorkflowBuildMarker(env = process.env, path = workflowBuildMarker) {
  const selected = provider(env.EVE_WORKFLOW_PROVIDER ?? "default");
  writeFileSync(path, `${selected}\n`, { flag: "w" });
  return selected;
}

/** Fail before serving if runtime configuration expects a different compiled world. */
/** @param {Record<string, string | undefined>} env */
export function verifyWorkflowBuild(env = process.env, path = workflowBuildMarker) {
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
