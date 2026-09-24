# Start from a fresh clone

Use Node 24.x and `npm ci`. Keep `.env.local` private; `.env.example` lists all supported settings. The root application includes Next and Eve in one install. These steps leave account chat disabled so records and account access can be checked before model costs or workflow storage are configured.

## Local Supabase

Docker must be running. The repository pins the Supabase CLI and includes a local Auth, PostgREST, PostgreSQL and email-inbox configuration. Run:

```sh
npm ci
npm run db:local:start
npm run db:local:status
cp .env.example .env.local
```

The status command prints local credentials: keep its output private. In `.env.local`, replace the SQLite/API-key defaults with the values from **your own** status output:

```dotenv
APP_ORIGIN=http://localhost:3000
DATA_PROVIDER=supabase
AUTH_PROVIDER=supabase
DATABASE_URL=<DB URL, for migrations only>
SUPABASE_URL=<API URL>
SUPABASE_AUTH_URL=<same API URL>
SUPABASE_SECRET_KEY=<secret or service_role key, server only>
SUPABASE_PUBLISHABLE_KEY=<publishable or anon key, browser safe>
AI_CHAT_ENABLED=false
```

Use the API URL reachable from the browser, normally loopback on port 54321. The database URL is a private direct connection to the local PostgreSQL server, normally port 54322. Never put a secret/service-role key into the publishable setting or a `NEXT_PUBLIC_*` variable. The local project uses `http://localhost:3000` as its site URL, allows the two exact callback paths used by signup and recovery, requires confirmed email and a 12-character password, and serves test mail at `http://127.0.0.1:54324`. It does not send mail externally.

Apply the application's canonical SQL before starting the app:

```sh
npm run db:migrate -- --dry-run
npm run db:migrate
npm run dev
```

Open `http://localhost:3000/signup`, register a disposable account, open its confirmation in the local inbox, and visit `/account`. Create a record and reload; it should remain private to that account. `npm run db:local:stop` stops this project's services while preserving its local data. The CLI's `db reset` and `db push` commands are **not** the schema workflow here: the authoritative SQL is `migrations/` and the repository's migration ledger. Do not use those CLI commands against this project.

## Hosted Supabase

Create a development Supabase project separate from preview and production. Obtain its API URL, browser publishable key, backend secret/service-role key and a private **direct or session** PostgreSQL migration URL. Configure email/password, confirmation, SMTP, Site URL and exact callback URLs for your application origin as described in [authentication](authentication.md). In a fresh clone:

```sh
npm ci
cp .env.example .env.local
```

Set the same variables shown above with the hosted values and your actual `APP_ORIGIN`. The URL and publishable key are browser settings; `DATABASE_URL` and `SUPABASE_SECRET_KEY` belong only on the server or migration job. Review a restorable database backup and `npm run db:migrate -- --dry-run`, then run `npm run db:migrate` **once** from a serial release process. Do not use the local CLI project's `db reset`, `db push`, or linked-project commands to deploy this app's schema. Start with `npm run dev` for a local application pointed at the development project, then rehearse signup, email confirmation, recovery and two-user record isolation. For a deployed application, follow [hosting](hosting.md) and run the [hosted data smoke](hosting.md#post-deployment-data-smoke) with two temporary users. No hosted account or deployment is provisioned by cloning.

## Optional capabilities and checks

- **API-key records without accounts:** leave the SQLite defaults, run `npm run auth:key -- local developer write`, place only its configuration array into `APP_API_KEYS`, then use the private token at `/records`. This needs neither Docker nor Supabase.
- **AI chat:** keep it off until both Next and Eve have the same identity, ownership store, signing keyring and a reviewed budget policy. Follow [account chat](account-chat.md); `AI_GATEWAY_API_KEY` may be needed for local model calls. A successful account login alone does not enable chat.
- **Other data providers:** follow [database setup](databases.md). Application data and Eve workflow storage are independent. The cloud PostgreSQL workflow build has additional build-time and runtime settings in [workflow storage](workflow-storage.md).
- **Validation:** `npm run check` covers types, lint and unit contracts; `npm run test:providers` uses disposable provider services; `npm run build:local` builds Eve and Next; `npm run test:auth` exercises disposable local Auth and browser flows after that build. `npm run test:chat` requires an additional deterministic Eve fixture and Docker. See [testing](testing.md) for the full matrix. These tests do not validate your hosted project's secrets, SMTP or paid model.

## Common setup failures

| Symptom | Check |
| --- | --- |
| Local CLI cannot reach Docker or bind a port | Start Docker, inspect `npm run db:local:status`, and free ports 54321, 54322 and 54324 for this project. |
| Account settings unavailable or login returns 503 | Verify `AUTH_PROVIDER=supabase`, API URL and publishable key, then restart the app after editing `.env.local`. |
| Email link fails or returns to the wrong host | Match `APP_ORIGIN`, the Supabase Site URL and the exact `/auth/callback?next=...` allowlist; use the same browser for default PKCE links. |
| PostgREST reports a missing table/function | Apply the repository's pending `db:migrate` files to the database behind that API URL. |
| Migration runner rejects an unknown applied migration | Stop and use the checkout that owns that migration; do not edit the ledger or run an older release over a newer schema. |
| Chat fails although records work | Check the separate [account chat](account-chat.md) and [workflow storage](workflow-storage.md) settings and readiness endpoints. |

To start over without losing data, stop and restart the local Supabase services. If this **disposable local** database can be erased, first back up anything you need, then run `npx supabase stop --project-id ai-app-jumpstart --no-backup`; that explicitly removes this project's local data volumes. Restart with `npm run db:local:start`, refresh `.env.local` from the new `npm run db:local:status` output, and apply `npm run db:migrate` again. A second clone with the same `project_id` shares the local service rather than creating an isolated dataset. Never use this reset on a hosted project. Release migrations require a reviewed backup and an operator who knows which environment is targeted.
