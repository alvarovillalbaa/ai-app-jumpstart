import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { Client } from "pg";
import { migrationJob, type MigrationOperation } from "../lib/deploy/migration-job";
import type { CloudProvider } from "../lib/deploy/cloud-config";
import { filledCloudManifest, migrationDatabaseReferences } from "../tests/helpers/cloud-manifest";
import { testCommand } from "./helpers/test-command.mjs";

// Called only by the disposable PostgreSQL harness, before application apply.
// Reference resolution is local test substitution, never a cloud credential read.
assert.ok(process.env.DATABASE_URL);
assert.ok(process.env.WORKFLOW_POSTGRES_URL);
assert.notEqual(process.env.DATABASE_URL, process.env.WORKFLOW_POSTGRES_URL);
const application = new Client({ connectionString: process.env.DATABASE_URL });
const workflow = new Client({ connectionString: process.env.WORKFLOW_POSTGRES_URL });
await application.connect();
await workflow.connect();
try {
  const migrationCount = (await readdir(new URL("../migrations/", import.meta.url))).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).length;
  const providers: CloudProvider[] = ["aws", "azure", "gcp"];
  const operations: MigrationOperation[] = ["application-preview", "application-apply", "workflow-apply"];
  for (const operation of operations) for (const provider of providers) {
    const job = migrationJob(provider, filledCloudManifest(provider), operation, "fixture-migration",
      operation === "workflow-apply" ? undefined : migrationDatabaseReferences[provider]);
    const container = (provider === "aws" ? job.containerDefinitions![0] : provider === "azure" ?
      job.properties!.template.containers[0] : job.spec!.template.spec.template.spec.containers[0]) as Record<string, unknown>;
    const command = (provider === "aws" ? container.entryPoint : container.command) as string[];
    const args = (provider === "aws" ? container.command : container.args) as string[];
    assert.deepEqual(command, ["node"]);
    const env = operation === "workflow-apply" ? {
      WORKFLOW_POSTGRES_URL: process.env.WORKFLOW_POSTGRES_URL,
      WORKFLOW_POSTGRES_JOB_PREFIX: "cloud_migration_fixture",
    } : { DATABASE_URL: process.env.DATABASE_URL };
    await testCommand(process.execPath, args, { env: { PATH: process.env.PATH, NODE_ENV: "production", ...env },
      timeout: 120_000 }, [process.env.DATABASE_URL!, process.env.WORKFLOW_POSTGRES_URL!]);
    if (operation === "application-preview") {
      assert.equal((await application.query("SELECT to_regclass('app_migrations')::text AS name")).rows[0].name, null,
        `${provider} preview changed the fresh database`);
    } else if (operation === "application-apply") {
      assert.equal((await application.query("SELECT count(*)::int AS count FROM app_migrations")).rows[0].count, migrationCount);
    } else {
      assert.equal((await workflow.query("SELECT to_regclass('workflow_drizzle.workflow_migrations')::text AS name")).rows[0].name, "workflow_drizzle.workflow_migrations");
      assert.ok((await workflow.query("SELECT count(*)::int AS count FROM workflow_drizzle.workflow_migrations")).rows[0].count > 0);
    }
  }
  console.log("Generated AWS/Azure/GCP migration commands passed: read-only previews, application apply/reruns and Workflow apply/reruns in two disposable databases.");
} finally { await application.end(); await workflow.end(); }
