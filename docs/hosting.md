# Hosting

Application data and Eve workflow state are separate. Selecting Supabase for records does not move Eve sessions to Supabase. Choose the default local/Vercel world or the opt-in [PostgreSQL workflow backend](workflow-storage.md) when building the artifact.

## Self-hosted Node / Docker

Use Node 24, `npm ci`, `npm run build:local`, `npm start`. The integrated runtime requires both Next output and Eve's `.output`. The start script verifies the compiled Workflow world, launches Eve, waits for its health endpoint, then launches Next; failure of either process stops both. Do not substitute bare `next start`: the saved rewrites do not start Eve in this pinned version. Next forwards both `/eve/` and `/.well-known/workflow/` to the local runtime. Persist `.data` for SQLite and `.eve` for local workflows. Use one instance with local storage; do not share SQLite WAL across replicas. Configure TLS, streaming proxy behavior, restart policies and backups.

Set `APP_ORIGIN` explicitly in every production environment to the browser-facing application origin, without credentials, path, query or fragment. Remote origins must use HTTPS; loopback HTTP is allowed for local checks. The same rule applies to the server-side Supabase URL and the Convex HTTP-actions origin before backend credentials are used. A missing production origin or an unsafe provider URL makes application readiness fail instead of silently using localhost or sending a credential over plaintext HTTP. Configure the same application origin on a separately hosted Eve service when it uses the shared application store.

```sh
docker compose up --build -d
docker compose logs -f app
```

Compose reads `.env.local` and binds loopback port 3000. PostgreSQL mode also needs `POSTGRES_PASSWORD` in local `.env` for Compose interpolation:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml up --build -d
```

The migration job completes before app startup. `docker compose down -v` destroys volumes; do not use it for routine shutdown. The image runs as the unprivileged Node user and includes pruned production dependencies. Run `npm run test:container` for an isolated image and restart-persistence check, then `npm run test:chat:container` for deterministic owned-turn browser checks with real disposable Auth. The PostgreSQL Compose overlay has passed a local healthy-start check, including its migration job. These checks do not prove a paid production-model call, cloud routing or durable multi-instance workflows. The multi-stage build still needs substantial temporary disk space.

## Maintainer-managed Vercel + Supabase

Before linking a project, run `npm run test:vercel-build` in a checkout without `.env.local`. It builds Next in Vercel mode, runs the generated Eve service build command, and checks the public agent route, Workflow callback, Node 24 runtime and streaming metadata. This is a credential-free local build contract; it does not create a Vercel project, apply migrations, test hosted Supabase or prove a deployed agent turn.

With the intended managed runtime settings in the operator shell or private `.env.local`, run `npm run check:managed-config`. It reuses the application's data/Auth/chat validators and requires explicit HTTPS origins, Supabase as both the application data and identity provider, an explicit chat switch, and the default Vercel Workflow world. Use `npm run check:managed-config -- --require-chat` when the release must support owned agent turns; also run `npm run check:budget-policy` to inspect its attributed quote. These commands make no network request, link no project and cannot validate key validity, migration state, Auth redirects, current provider prices or runtime reachability. Follow them with migration preview/review and the post-deployment smoke below.

1. Provision a separate Supabase project per environment/organization. Set its private `DATABASE_URL`, review `npm run db:migrate -- --dry-run` and a restorable backup, then apply `npm run db:migrate` from one release job.
2. Configure Vercel with `DATA_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AUTH_PROVIDER=supabase`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ORIGIN` and appropriate model credentials. `APP_API_KEYS` is optional for administrator-issued API/CLI/MCP credentials. To enable private upload quarantine, also set `UPLOAD_STORAGE_PROVIDER=supabase` after applying migrations and provisioning the private bucket as described in [uploads](uploads.md); no unscanned file can be downloaded. Follow [account setup](authentication.md) for SMTP and redirect URLs. Separate Preview and Production secrets.
3. Use `npx eve link --non-interactive --project NAME` and `npx eve deploy --non-interactive --yes --project NAME`. `withEve` generates the integrated service output.
4. Keep `EVE_WORKFLOW_PROVIDER` unset/default for the managed Vercel world. Configure opt-in [account chat](account-chat.md), then verify web liveness, data readiness, authenticated cross-user API/MCP access and a real owned agent turn.

Account chat is disabled by default. When enabled, signed creation and verified browser ownership form the exclusive policy, with no local-development or OIDC fallback. See [agent session access](agent-session-access.md).

## Post-deployment data smoke

The same read/write smoke works against Vercel, a self-hosted Node service, or any of the cloud container targets. From a source checkout with `npm ci` installed, provision two temporary `APP_API_KEYS` credentials with `records:read` and `records:write` scopes for different subjects in the same tenant. Export their raw tokens as `APP_API_TOKEN` and `APP_API_OTHER_TOKEN`, and set `APP_API_URL` to the exact HTTPS deployment origin. Keep tokens in your secret manager or shell environment, not command arguments or committed files. Then run:

```sh
npm run smoke:hosted
```

For a deployment with Supabase accounts and `AI_CHAT_ENABLED=true`, sign in two distinct temporary staging users through the configured Auth provider and put their current access tokens into the same two shell variables. Run:

```sh
npm run smoke:hosted -- --accounts
```

This mode additionally requires both tokens to reach the registered-user-only usage endpoint and a configured account budget policy. It makes no model call and creates no conversation. Do not use a service-role key or an application record key as an account token. Use fresh tokens if the Auth session expires.

After reviewing the staging account's model allowance, run one real owned turn through the same deployed origin:

```sh
npm run smoke:hosted -- --agent
```

This explicit mode runs the two-account data smoke, creates one conversation for the first user, waits for its durable owner binding, checks that the second user cannot read its metadata, stream or projections, and requires a completed Eve model step, turn, nonempty response and captured application projections. It does not retry creation or send a follow-up. The conversation, usage and provider charge remain on the first account; use disposable staging users and inspect the printed operation ID if the run times out. A passing result proves that one turn worked at that deployment, not replay after replacement, every tool, or a fixed invoice ceiling.

All modes check web/data/Eve health, the records page, anonymous denial, cross-owner list/read/edit/delete denial, and one owner's REST, CLI and MCP reads of a temporary record. The command deletes that record even if a later check fails. A lost create response can still leave a record behind; the command prints its unique title for manual review and never retries the write. It rejects remote HTTP and redirects. The `--accounts` mode proves server-side token acceptance and owner isolation without a model call; `--agent` additionally proves one owned turn. Neither proves the browser signup/email flow or workflow replay after replacement. Run those acceptance cases separately before release. For a protected Vercel deployment, export its automation bypass secret as `VERCEL_AUTOMATION_BYPASS_SECRET` in the operator shell; the smoke sends Vercel's [recommended header](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) on web, REST, CLI, MCP and Eve requests. Keep this secret out of URLs and logs.

## AWS / Azure / GCP / Amplify

The [cloud container recipes](cloud-containers.md) include ECS/Fargate, Azure Container Apps and Cloud Run definitions using managed secret references, remote application data and PostgreSQL workflows. Runtime replacement/replay is tested locally with the compiled PostgreSQL world; `npm run test:workflow-compose` also checks the combined two-database container stack and app replacement. Cloud control-plane validation and deployed acceptance remain pending. A local workflow world requires persistent storage and one instance. PostgreSQL workers require continuously available CPU, a private workflow database and explicit migrations.

Amplify compatibility remains blocked by the currently documented Next.js version and streaming support: this app uses Next.js 16.3.5, while [AWS Next.js support](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html) documents versions through 15 and excludes Next.js streaming (checked 2026-09-24). [Node 24 is supported](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-supported-features.html), but that does not resolve either mismatch. A separately hosted Eve service does not itself resolve the web-side mismatch. See the explicit gate in the cloud recipes; no Amplify deployment is certified.

For split services, this installed `withEve` appends a private service prefix to `EVE_NEXT_PRODUCTION_ORIGIN`. Verify the reverse-proxy mapping and workflow callbacks, then complete a real turn. Platform recipes remain incomplete until those checks pass.
