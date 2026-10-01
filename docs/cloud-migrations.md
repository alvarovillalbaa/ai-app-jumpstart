# Cloud release migration jobs

Generate one-off migration jobs from the same reviewed, filled runtime manifest used for [cloud containers](cloud-containers.md). The generator validates that manifest, pins the same application image digest, removes the web/agent processes and ingress, and selects only the database environment needed by the chosen operation. It writes a new private JSON file and never calls a cloud API, reads a secret value, runs SQL or changes the runtime input.

| Operation | Container command | Database |
| --- | --- | --- |
| `application-preview` | `node scripts/migrate.ts --dry-run` | Application PostgreSQL/Supabase migration connection |
| `application-apply` | `node scripts/migrate.ts` | Same application connection |
| `workflow-apply` | `node scripts/migrate-workflow.mjs` | Workflow PostgreSQL connection and job prefix |

The application preview lists pending migration filenames inside a read-only transaction. It does not prove the SQL will succeed. Application apply uses the existing transaction, advisory lock and migration ledger. Workflow apply delegates to the pinned package's migration owner; there is no Workflow dry-run mode. These are separate databases and separate job executions, without a cross-database transaction. A successful first job and failed second job require inspection before retry or rollout. An older application image does not undo migrations.

## Prepare the database reference

Application jobs require a separate managed reference for `DATABASE_URL`. The running Supabase application uses an HTTP backend key, which is insufficient for SQL migrations. Keep the migration database credential out of the runtime app manifest. Save exactly one of these reference shapes to an operator-owned JSON file, replacing example references with the intended staging migration secret:

AWS:

```json
{"name":"DATABASE_URL","valueFrom":"arn:aws:secretsmanager:eu-west-1:123456789012:secret:staging-migration-database"}
```

Azure:

```json
{"name":"migration-database","keyVaultUrl":"https://YOUR_VAULT.vault.azure.net/secrets/staging-migration-database/YOUR_VERSION","identity":"YOUR_MANAGED_IDENTITY_RESOURCE_ID"}
```

GCP (use a numbered secret version in the job's project):

```json
{"name":"DATABASE_URL","valueFrom":{"secretKeyRef":{"name":"staging-migration-database","key":"1"}}}
```

These files contain references, not connection strings. Plaintext `value` and unexpected fields are rejected. The referenced secret value must hold the private migration connection, with reviewed DDL permissions and TLS settings. Workflow jobs reuse only the runtime manifest's `WORKFLOW_POSTGRES_URL` reference and `WORKFLOW_POSTGRES_JOB_PREFIX`; they reject an application database reference.

## Generate and review

Run from a source checkout with `npm ci`. Choose `aws`, `azure` or `gcp`, and an existing private output directory. Each output filename must be unused:

```sh
npm run cloud:migration-job -- --provider aws --file PRIVATE_RUNTIME.json \
  --operation application-preview --name staging-app-preview \
  --database-secret PRIVATE_DATABASE_REFERENCE.json --output PRIVATE_APP_PREVIEW.json
npm run cloud:migration-job -- --provider aws --file PRIVATE_RUNTIME.json \
  --operation application-apply --name staging-app-apply \
  --database-secret PRIVATE_DATABASE_REFERENCE.json --output PRIVATE_APP_APPLY.json
npm run cloud:migration-job -- --provider aws --file PRIVATE_RUNTIME.json \
  --operation workflow-apply --name staging-workflow-apply --output PRIVATE_WORKFLOW_APPLY.json
```

The generated job initially reuses the runtime image-pull configuration and provider identity. Review and substitute a dedicated release identity with only the required registry, secret and database access before submitting it. Environment selection is operator-owned; the generator cannot distinguish production from staging. For AWS, the job keeps the execution role for image pulls, logs and managed-secret injection, and omits the runtime task role so migrations do not inherit app permissions such as S3 access. Azure preserves identity-based private-registry configuration and rejects registry username/password references. GCP preserves the runtime's supported VPC, Cloud SQL, encryption and secret-alias annotations; review aliases and add a migration-secret alias explicitly if using cross-project secrets. Other provider networking/IAM settings still need review.

Azure jobs are manual, with one replica, no automatic retries and a 300-second replica timeout. GCP jobs have one task, parallelism one, no automatic retries and a 300-second task timeout. Review the deadline against migration size. An AWS standalone task has no equivalent generated job deadline: the release runner must enforce a deadline, stop a stalled task and inspect database state. Do not put migration tasks into a continuously restarting ECS service or run them in every app replica.

## Submit only in the controlled release path

These commands create or execute cloud resources when an operator runs them. Register each reviewed job separately, run application preview, inspect pending SQL and a restorable backup, run application apply, then Workflow apply. Observe a successful terminal execution for both applies before updating the runtime service.

- AWS: register with `aws ecs register-task-definition --cli-input-json file://PRIVATE_JOB.json`; run that task revision once with `aws ecs run-task`, Fargate launch type, the reviewed private subnet/security-group configuration and count one. Inspect API failures, wait for the returned task ARN to stop and require the migration container's exit code to be zero. A successful registration or `run-task` request is insufficient.
- Azure: create with `az containerapp job create --name JOB --resource-group GROUP --yaml PRIVATE_JOB.json`, then `az containerapp job start --name JOB --resource-group GROUP`. Inspect the returned execution and require status `Succeeded` before proceeding. Registration is separate from execution.
- GCP: register with `gcloud run jobs replace PRIVATE_JOB.json --region REGION --project PROJECT`, then `gcloud run jobs execute JOB --region REGION --project PROJECT --wait`. Require successful execution and inspect failed tasks.

Use a single serial release owner per environment. Cloud job settings limit one execution's replicas; they do not prevent two operators from starting separate executions concurrently. Never submit jobs from untrusted PR workflows using hosted database credentials. Keep failure diagnostics private and review cloud logs before sharing them.

The output follows the documented [ECS task definition](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html), [Azure manual job](https://learn.microsoft.com/en-us/azure/container-apps/jobs) and [Cloud Run job](https://docs.cloud.google.com/run/docs/reference/yaml/v1#cloud_run_job_yaml) formats. Local PostgreSQL tests execute all nine generated command variants: previews leave a fresh application database unchanged; apply and reruns retain every source migration; Workflow apply and reruns create the pinned package's migration ledger in a separate database. Unit/CLI checks cover secret selection, command overrides, private connectivity, private output and no-clobber. This is local command and structural evidence; cloud API acceptance, IAM, registry delivery, networking and hosted execution remain unverified.
