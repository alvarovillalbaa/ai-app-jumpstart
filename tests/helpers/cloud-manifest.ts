import { readFileSync } from "node:fs";
import type { CloudProvider } from "../../lib/deploy/cloud-config";

export function filledCloudManifest(provider: CloudProvider) {
  const files = { aws: "deploy/aws/task-definition.example.json", azure: "deploy/azure/container-app.example.json", gcp: "deploy/gcp/service.example.json" };
  return JSON.parse(readFileSync(files[provider], "utf8")
    .replaceAll("REPLACE_WITH_POSTGRES_WORKFLOW_IMAGE_AT_SHA256_DIGEST", `registry.example/app@sha256:${"a".repeat(64)}`)
    .replaceAll("REPLACE_WITH_INGRESS_IMAGE_AT_SHA256_DIGEST", `registry.example/ingress@sha256:${"b".repeat(64)}`)
    .replaceAll("REPLACE_WITH_EXECUTION_ROLE_ARN", "arn:aws:iam::123456789012:role/fixture-execution")
    .replaceAll("REPLACE_WITH_TASK_ROLE_ARN", "arn:aws:iam::123456789012:role/fixture-task")
    .replace(/REPLACE_WITH_[A-Z0-9_]+_SECRET_ARN/g, "arn:aws:secretsmanager:eu-west-1:123456789012:secret:fixture")
    .replace(/REPLACE_[A-Z0-9_]+/g, "fixture"));
}

export const migrationDatabaseReferences = {
  aws: { name: "DATABASE_URL", valueFrom: "arn:aws:secretsmanager:eu-west-1:123456789012:secret:migrations" },
  azure: { name: "migration-database", keyVaultUrl: "https://fixture.vault.azure.net/secrets/app-database/version1", identity: "fixture-identity" },
  gcp: { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "migration-database", key: "1" } } },
};
