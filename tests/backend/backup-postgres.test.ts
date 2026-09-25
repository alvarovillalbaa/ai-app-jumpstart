import { expect, it } from "vitest";
import { backupPostgresWorkflow, libpqEnvironment } from "../../scripts/backup-postgres.mjs";
import { createPostgresDatabaseSet } from "../../scripts/backup-postgres-databases.mjs";

it("passes PostgreSQL URL credentials through libpq environment without inheriting another target", () => {
  const result = libpqEnvironment(
    "postgresql://backup:p%40ss%3Aword@127.0.0.1:5432/app_test?sslmode=verify-full&sslrootcert=%2Fprivate%2Froot.pem",
    { NODE_ENV: "test", PGHOST: "wrong.example", PGPASSWORD: "old", PGSERVICE: "production", DATABASE_URL: "old-secret", WORKFLOW_POSTGRES_URL: "workflow-secret", BACKUP_VERIFY_APP_DATABASE_URL: "app-target-secret", BACKUP_VERIFY_WORKFLOW_DATABASE_URL: "workflow-target-secret", OTHER_SETTING: "kept" },
  );
  expect(result).toMatchObject({ host: "127.0.0.1", port: "5432", database: "app_test" });
  expect(result.env).toMatchObject({
    PGHOST: "127.0.0.1", PGUSER: "backup", PGPASSWORD: "p@ss:word", PGDATABASE: "app_test",
    PGSSLMODE: "verify-full", PGSSLROOTCERT: "/private/root.pem", OTHER_SETTING: "kept",
  });
  expect(result.env).not.toHaveProperty("PGSERVICE");
  expect(result.env).not.toHaveProperty("DATABASE_URL");
  expect(result.env).not.toHaveProperty("WORKFLOW_POSTGRES_URL");
  expect(result.env).not.toHaveProperty("BACKUP_VERIFY_APP_DATABASE_URL");
  expect(result.env).not.toHaveProperty("BACKUP_VERIFY_WORKFLOW_DATABASE_URL");
});

it("refuses ambiguous or unsupported PostgreSQL connection options", () => {
  expect(() => libpqEnvironment("postgresql://user:pass@localhost/db?sslmode=require&sslmode=disable"))
    .toThrow("repeated");
  expect(() => libpqEnvironment("postgresql://user:pass@localhost/db?unsafe_option=value"))
    .toThrow("Unsupported");
  expect(() => libpqEnvironment("postgresql://user:pass@localhost/db#fragment"))
    .toThrow("without a fragment");
});

it("requires a stopped-writer acknowledgement before a Workflow archive", () => {
  expect(() => backupPostgresWorkflow("postgresql://user:pass@localhost/workflow", "/tmp/workflow.dump"))
    .toThrow("Stop all Eve Workflow writers");
});

it("requires both disposable restore targets for a stopped database set", async () => {
  const input = { applicationUrl: "postgresql://user:pass@localhost/app",
    workflowUrl: "postgresql://user:pass@localhost/workflow",
    output: "/tmp/unused-postgres-database-set", stopped: true };
  await expect(createPostgresDatabaseSet({ ...input, applicationRestoreUrl: "postgresql://user:pass@localhost/app_restore" }))
    .rejects.toThrow("provide both empty loopback restore database URLs");
});
