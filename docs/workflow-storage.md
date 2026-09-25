# Workflow storage

Application records, ownership and budgets use `DATA_PROVIDER`. Eve execution uses a separate Workflow world. Both stores must survive replacement; changing the application database alone does not persist agent execution.

| Deployment | Build selection | Execution persistence |
| --- | --- | --- |
| Local Node or single-host Docker | Default | `.eve/.workflow-data` on a durable volume |
| Managed Vercel | Default | Vercel Workflow |
| Long-running containers on AWS/Azure/GCP or other hosts | `EVE_WORKFLOW_PROVIDER=postgres` | Explicit private PostgreSQL database |

For the default local world, use the [offline self-hosted snapshot](local-recovery.md) to copy `.eve/.workflow-data` alongside the application SQLite database and optional local upload objects after stopping writers. The PostgreSQL world has a separate private archive and restore rehearsal below.

The production model is unchanged. `agent/lib/workflow.ts` selects the world at **build time**, through Eve's documented `experimental.workflow.world` option. Runtime environment variables alone cannot turn a default/local artifact into a PostgreSQL artifact. `build:local` writes the selected world into `.output/jumpstart-workflow-provider`; the production supervisor reads this marker before starting either service. Set `WORKFLOW_EXPECTED_PROVIDER=postgres` on long-running cloud containers, as the supplied manifests do. Startup fails if the artifact is unmarked, has the wrong world, or the PostgreSQL world lacks its connection URL. A default-world build also refuses an accidental `WORKFLOW_POSTGRES_URL`. Rebuild when changing the world. Keep each environment's image digest, build selection and database references in its release record.

## PostgreSQL setup

The adapter is pinned to `@workflow/world-postgres@5.0.0-beta.42`. Its world, local-world, utils and errors versions match the line bundled by Eve 0.54.5. Do not install the npm `latest` tag: the stable 4.x world uses a different protocol. Re-run both runtime suites before upgrading either dependency.

`@jumpstart/workflow-postgres` wraps the upstream factory. It requires an explicit `WORKFLOW_POSTGRES_URL` and a stable `WORKFLOW_POSTGRES_JOB_PREFIX`, validates concurrency/pool settings, and rejects known request-scoped function hosts. It never falls back to `DATABASE_URL` or example database credentials. Eve's generated Nitro plugin starts and closes the worker. No second Next instrumentation worker is required.

1. Provision a private PostgreSQL database and a backend-only database role. Workflow history may contain messages and tool results. Do not expose its schemas through browser roles or PostgREST. Use a separate database from application tables, backups, verified TLS, and a direct/session connection supporting LISTEN/NOTIFY; transaction-mode pooling is unsuitable.
2. Set the workflow URL, a unique prefix per app/environment, and optional pool/concurrency values in the process secret environment. The default worker concurrency is 5 and pool maximum is 10 **per instance**. Account for all instances and other database clients when sizing connection limits.
3. Run `npm run workflow:migrate` once in a serial release job before starting workers. It uses the pinned upstream migration owner for both Workflow and Graphile Worker schemas. Its subprocess output is suppressed to prevent database URL parameters from entering logs. Failure returns nonzero; inspect database connectivity, privileges and package compatibility. Keep application migrations separate: `npm run db:migrate` does not prepare workflow tables.
4. Build with `EVE_WORKFLOW_PROVIDER=postgres npm run build:local`, or `docker build --build-arg EVE_WORKFLOW_PROVIDER=postgres -t YOUR_IMAGE .`. The build marker contains only `postgres`; runtime credentials are not build arguments and must not enter image layers.
5. Supply `WORKFLOW_EXPECTED_PROVIDER=postgres` and the workflow settings when starting the resulting artifact. Supply a remote application `DATA_PROVIDER` on ephemeral/multi-instance hosts. Use the [cloud recipes](cloud-containers.md), then complete the acceptance checks.

For a local Compose workflow database, put a URL-safe random hex `WORKFLOW_DB_PASSWORD` in Compose's private `.env` and application secrets in `.env.local`:

```sh
docker compose -f compose.yaml -f compose.workflow-postgres.yaml up --build -d
```

Add `-f compose.postgres.yaml` and its `POSTGRES_PASSWORD` to put application data in a second PostgreSQL database/service. The separate migration jobs must finish before the app starts. Each database has its own named volume; ordinary `down` retains them, while `down -v` destroys them. `npm run test:workflow-compose` builds the PostgreSQL Workflow image and exercises this combined stack with random test credentials, both migration jobs, health checks and an app-container replacement. Use `-- --skip-build` with `TEST_WORKFLOW_IMAGE` to test an existing image. The harness uses a temporary override and project, leaves `.env.local` untouched, and removes only its own containers and volumes.

## Back up a PostgreSQL Workflow world

Stop every Eve instance and Workflow worker for the selected environment, prevent automatic restarts during the snapshot, and resolve any jobs still locked by a worker. Set the private `WORKFLOW_POSTGRES_URL` in the operator environment and use PostgreSQL client tools at least as new as the server's major version. Choose a new path in a private backup directory, then run:

```sh
npm run workflow:backup -- --output /PRIVATE_BACKUPS/workflow-YYYYMMDD.dump --stopped
```

`--stopped` acknowledges the shutdown; the command cannot prove every host is stopped. It checks the Workflow and Graphile migration schemas, refuses locked jobs, creates a custom-format archive in a private temporary directory, verifies its table of contents, and publishes a mode-0600 file without replacing an existing path. Credentials stay out of client process arguments. A readable archive does not prove that the world can resume.

For a restore rehearsal, create a separate empty **loopback** PostgreSQL database, set its private URL as `BACKUP_VERIFY_DATABASE_URL`, and add `--verify-restore` to the command above with a new output path. The command restores in one transaction and compares Workflow/Graphile migration counts plus run and event counts. The disposable restore omits ownership and ACL statements; the archive retains them. Test production roles, grants, worker settings, and an owned session continuation against the restored world before relying on it. The local runtime suite does the session replay and continuation with a deterministic model.

This archive covers one Workflow database only. If the application uses PostgreSQL, stop its writers in the same maintenance window and take a separate [application database archive](operations.md); these two commands do not create an atomic cross-database snapshot. Back up private object bytes separately. Vercel's default managed Workflow world is outside this command's scope; follow its provider recovery procedure.

## Validation and limits

`npm run test:workflow-postgres` provisions a disposable native PostgreSQL instance, runs the workflow bootstrap twice and compiles a fresh Eve fixture with the production world selector, ownership and budget hooks. It exercises signed creation/recovery, follow-up, compaction, ownership denial and quota denial. It kills the runtime, removes local workflow files, restarts, replays completed history without a model rerun, and completes another owned turn. Fixture models make no paid provider calls. The application ownership/budget store in this test is intentionally separate SQLite; remote application adapters have their own contract suites.

This proves completed-session persistence and continuation after a stopped database archive/restore and process replacement. It does **not** prove exactly-once provider execution during a crash inside a model/tool call, recovery of every in-flight checkpoint, concurrent multi-instance rollout, cloud networking or a coordinated hosted backup. Those remain release acceptance work. The local [artifact action](approved-artifacts.md) stores one effect per approved call ID and input hash; its hosted in-flight replay still needs validation. A stale Eve input response can be converted to new user input; the test exhausts the account budget and confirms that it cannot grant extra allowance.

The Compose harness proves that the release image starts with both PostgreSQL services, that both schema jobs complete, and that application records survive replacement. It does not execute an owned model turn against the Compose deployment; the separate `test:workflow-postgres` runtime fixture covers completed-turn replay against a PostgreSQL world.

The upstream world requires a continuously running worker and is not suitable for request-scoped functions. Cloud Run must allocate CPU outside requests and keep a worker instance running. Use Vercel's default managed world on Vercel. See the [Workflow PostgreSQL guide](https://workflow-sdk.dev/worlds/postgres) and installed `node_modules/eve/docs/guides/deployment/self-hosting.md`.

## Recover a job locked by a dead worker

An abrupt `SIGKILL` can leave Graphile Worker jobs claimed by the dead process. The pinned worker normally releases such locks after four hours, so a replacement instance can be healthy while that turn remains parked. Graceful shutdown takes a different path and unlocks active work through the worker's failure handling. See [Graphile Worker's crash recovery explanation](https://worker.graphile.org/docs/pro/recovery).

Use a controlled process with the same private `WORKFLOW_POSTGRES_URL` and `WORKFLOW_POSTGRES_JOB_PREFIX` as the affected deployment. First list this application's locked jobs; the output includes job and worker IDs, timestamps and attempt counts, but no payloads:

```sh
npm run workflow:recover -- list
```

After confirming that the listed worker ID belongs to a process that has terminated on every host, unlock that exact worker. The command refuses a worker ID that also holds jobs outside this application's prefix. It does not identify dead workers automatically; a network-isolated worker could still be executing a side effect.

```sh
npm run workflow:recover -- unlock --worker-id WORKER_ID --confirm-dead
```

The disposable PostgreSQL runtime fixture kills Eve inside a model call, observes the locked job, unlocks the confirmed-dead worker, restarts Eve and waits for the turn boundary. Its durable one-call budget cap prevents a second model invocation; the turn fails, releases its active reservation and retains the conservative estimate as unknown cost. This is a fail-closed recovery for that case, not an exactly-once guarantee for arbitrary models or side-effecting tools. Review the stream, budget ledger and external provider effects before retrying the user request.
