# Database setup

The record service fixes ownership from the authenticated principal. Every adapter implements the same CRUD, cursor, revision and isolation contract. Browser, REST, CLI and MCP use the application server; database administrative credentials stay server-side. Separate adapters store application session ownership, replay receipts and usage reservations using the same provider, not Eve workflow state. See [agent session access](agent-session-access.md) and [usage budgets](usage-budgets.md) for the remaining runtime integration.

## SQLite

Set `DATA_PROVIDER=sqlite` and optionally `SQLITE_PATH` (default `.data/app.sqlite`). The first connection initializes the schema. Persist this directory and run one application instance. Do not use SQLite on ephemeral serverless storage or share its WAL files between replicas.

Use the [SQLite backup procedure](operations.md) before upgrades and rehearse restoring its single-file snapshot into a fresh directory. The command accepts an explicit source path, so point it at the actual `SQLITE_PATH` for that deployment. It does not cover local upload objects or Eve's separate workflow state.

## PostgreSQL and Supabase

Set `DATABASE_URL` to a private migration connection. Run `npm run db:migrate -- --dry-run` to list pending SQL files without creating the migration ledger or changing the schema, review the list and a restorable backup, then run `npm run db:migrate` in a serial release job. Both commands refuse a database whose ledger contains migrations absent from this checkout, so an older release cannot silently treat a newer schema as current. The migration runner records applied versions and uses a transaction and advisory lock. A dry run checks the current ledger only; it does not validate SQL execution or prevent another release from changing the database before the apply step. Never migrate per request.

`npm run test:postgres` and `npm run test:supabase` each rehearse an upgrade from a populated, pre-checkpoint schema in a separate disposable database. They verify the dry run leaves the schema and ledger alone, apply the pending migrations through the real runner, rerun it safely, and check that existing records and conversation events survive. The Supabase rehearsal also checks the upgraded RPC grant and restrictive Storage policy. This fixed migration boundary is a local upgrade regression test, not a rehearsal against a tagged release or a hosted database; test the actual release backup and target separately.

For direct PostgreSQL access, set `DATA_PROVIDER=postgres` and `DATABASE_URL` on the application. Managed PostgreSQL services use this same adapter; configure TLS using the provider's connection instructions.

For Supabase PostgREST, set `DATA_PROVIDER=supabase`, `SUPABASE_URL` and `SUPABASE_SECRET_KEY` on the application. Use a backend secret/service-role credential, never an anonymous or publishable key. The migration enables RLS and denies direct `anon` and `authenticated` table access. The backend enforces owner predicates on every operation. Browser signup is configured separately through `AUTH_PROVIDER=supabase`; see [authentication](authentication.md).

The committed `lib/data/supabase.generated.ts` is generated from the migrated local public schema with the pinned CLI. After adding a SQL migration, apply it to local Supabase and run `npm run db:types`; `npm run db:types:check` detects drift. The generator refuses a local database with unapplied repository migrations. It never generates from a linked or hosted project.

Use separate projects and credentials for development, preview and production. The local PostgREST integration test verifies role denial and adapter behavior; it does not validate a hosted project's configuration, backups or networking.

## Convex

Run `npm run convex:dev` to configure a development deployment and publish the functions in `convex/`. For an isolated acceptance test without an account, use `npm run test:convex` instead; it creates and destroys its own anonymous local backend.

Generate a private random secret of at least 32 characters using your secret manager. Configure `CONVEX_BACKEND_SECRET` in both the application environment and the target Convex deployment. `npx convex env set CONVEX_BACKEND_SECRET` reads the value from standard input; avoid placing the value in command arguments or shell history.

Configure the application:

```dotenv
DATA_PROVIDER=convex
CONVEX_SITE_URL=https://YOUR-DEPLOYMENT.convex.site
CONVEX_BACKEND_SECRET=YOUR-PRIVATE-RANDOM-SECRET
```

Use the HTTP-action origin ending in `.convex.site`, not the `.convex.cloud` query origin. Local loopback HTTP is accepted for development; remote origins require HTTPS. Configure the same secret on each side before serving traffic. The adapter exposes failures as public application errors, without forwarding database responses or credentials.

Deploy the backend with `npx convex deploy` against the intended deployment, then deploy the application with matching environment variables. Convex does not use the SQL migration command. Commit the generated bindings under `convex/_generated/`; regenerate them after function changes with `npm run convex:codegen` against your configured development deployment.

Only `/app/records` is public, and every request requires the backend secret. Record and session-access queries and mutations are internal functions, so browser clients cannot bypass application authentication by naming a Convex function directly. Updates and deletes check revisions transactionally. This adapter provides the shared request/response contract; it does not add browser subscriptions. To regenerate bindings using a disposable deployment instead of a configured account, run `npm run test:convex -- --update-codegen`.

### Upgrading existing conversation metadata

The history schema keeps its new fields optional so existing Convex documents remain deployable. After deploying the functions, run the admin CLI against the intended deployment:

```sh
npx convex run access:backfillMetadata '{}'
```

Repeat until `remaining` is `false`; each transaction updates at most 100 legacy documents. Use the CLI's explicit production/deployment selector for a hosted target. The migration assigns **New conversation**, preserves `_creationTime` as the original creation date, and retains ownership, operation IDs, runtime bindings and revocations. Re-running is safe. A user with unmigrated conversations receives a history error rather than an incomplete list; existing session access remains available. This is an internal function with no public HTTP command. New reservations already contain history metadata.

SQL providers instead apply `20260922110152_conversation_history.sql` through `db:migrate`. Older rows have no creation date and retain zero as an explicit unknown. SQLite applies the same additive metadata upgrade on connection. None of these upgrades grants direct browser access to the ownership tables.
