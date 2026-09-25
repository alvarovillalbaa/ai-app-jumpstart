# Hosting

Application data and Eve workflow state are separate. Selecting Supabase for records does not move Eve sessions to Supabase. Choose the default local/Vercel world or the opt-in [PostgreSQL workflow backend](workflow-storage.md) when building the artifact.

## Self-hosted Node / Docker

Use Node 24, `npm ci`, `npm run build:local`, `npm start`. The integrated runtime requires both Next output and Eve's `.output`. The start script verifies the compiled Workflow world, launches Eve, waits for its health endpoint, then launches Next; failure of either process stops both. Do not substitute bare `next start`: the saved rewrites do not start Eve in this pinned version. Next forwards both `/eve/` and `/.well-known/workflow/` to the local runtime. Persist `.data` for SQLite and `.eve` for local workflows. Use one instance with local storage; do not share SQLite WAL across replicas. Configure TLS, streaming proxy behavior, restart policies and the [offline recovery procedure](local-recovery.md).

The integrated self-hosted command's Next rewrite can buffer an SSE response until Eve finishes it. For live token delivery through a production ingress, route `/eve/*` and `/.well-known/workflow/*` directly to Eve as described below; route other paths to Next. Keep direct upstream ports private. The ordinary self-hosted tests prove completed turns, not token-by-token delivery through Next's rewrite.

Set `APP_ORIGIN` explicitly in every production environment to the browser-facing application origin, without credentials, path, query or fragment. Remote origins must use HTTPS; loopback HTTP is allowed for local checks. The same rule applies to the server-side Supabase URL and the Convex HTTP-actions origin before backend credentials are used. A missing production origin or an unsafe provider URL makes application readiness fail instead of silently using localhost or sending a credential over plaintext HTTP. Configure the same application origin on a separately hosted Eve service when it uses the shared application store.

```sh
docker compose up --build -d
docker compose logs -f app
```

Compose reads `.env.local` and binds loopback port 3000. For opt-in upload scanning, mount a private ClamAV Unix socket into the app container, set `UPLOAD_SCANNER_PROVIDER=clamd` and `UPLOAD_CLAMD_SOCKET` to its in-container path, and run `npm run check:upload-scanner` inside the same runtime environment. The default Compose files do not start a scanner. PostgreSQL mode also needs `POSTGRES_PASSWORD` in local `.env` for Compose interpolation:

```sh
docker compose -f compose.yaml -f compose.postgres.yaml up --build -d
```

The migration job completes before app startup. `docker compose down -v` destroys volumes; do not use it for routine shutdown. The image runs as the unprivileged Node user and includes pruned production dependencies. Run `npm run test:container` for an isolated image and restart-persistence check, then `npm run test:chat:container` for deterministic owned-turn browser checks with real disposable Auth. The PostgreSQL Compose overlay has passed a local healthy-start check, including its migration job. These checks do not prove a paid production-model call, cloud routing or durable multi-instance workflows. The multi-stage build still needs substantial temporary disk space.

For live SSE through a local Compose ingress, add the [streaming overlay](../compose.streaming.yaml) last. It removes the app's direct host port, binds Eve inside the private Compose network, and publishes only Caddy on loopback port 3000. Keep `APP_ORIGIN=http://localhost:3000` for this local example. Docker Compose 2.24.4 or later is required for the [`!override` port replacement](https://docs.docker.com/reference/compose-file/merge/#replace-value):

```sh
docker compose -f compose.yaml -f compose.streaming.yaml up --build -d
# With PostgreSQL, use: -f compose.yaml -f compose.postgres.yaml -f compose.streaming.yaml
```

The merged SQLite and PostgreSQL configurations were validated locally. A fresh SQLite image and Compose stack served `/records`, app readiness (`data: ok`, `agent: ok`), Eve health and authenticated record create/read/delete through Caddy; Docker showed no published app/Eve ports. The disposable project and volumes were removed. The separate SSE fixture check below proves streaming through the same Caddy route; the real stack check did not execute a model turn.

## Split Next and Eve behind one streaming ingress

Run the compiled Next and Eve services on a private network. Build Next with `EVE_NEXT_PRODUCTION_ORIGIN` set to Eve's private origin and retain that setting at runtime so `npm start` does not launch a second local Eve process. Start the standalone Eve output with `npm run start:eve -- --host 0.0.0.0 --port 4274` inside its private container. Configure the same browser-facing HTTPS `APP_ORIGIN`, auth and application data store for both services, plus durable Workflow storage for Eve. Next's rewrite destinations are compiled at build time, so use a stable internal name or build separately per environment.

Place [the Caddy ingress example](../deploy/split-app.Caddyfile) behind the only public TLS endpoint. Set `NEXT_UPSTREAM` to the private Next host and port, and `EVE_UPSTREAM` to the private Eve host and port. It forwards `/eve/*` and `/.well-known/workflow/*` to Eve without changing their paths and sends the rest to Next. The Eve stream bypasses Next's buffering rewrite. Bind the two upstreams only on the private network; the example listens on HTTP port 8080 for a trusted TLS load balancer, or can be adapted to terminate TLS itself. Caddy's [route handling](https://caddyserver.com/docs/caddyfile/directives/handle) and [streaming proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) are the basis for this example.

The ingress supplies the same baseline response-security headers to Eve/Workflow routes that Next supplies to its own routes, only when the upstream has not set them. It enforces `Cache-Control: no-store` on Eve/Workflow responses and preserves Next's per-request CSP. Configure HTTPS and HSTS at the actual public TLS terminator; this internal HTTP example cannot prove those edge settings.

Build the deployable proxy from [the ingress Dockerfile](../deploy/ingress.Dockerfile), then run `npm run test:split-ingress` with Docker to exercise route selection, Workflow callback body/query forwarding, response-security defaults, upstream CSP preservation and two separately delivered SSE events. A local production Next build with `EVE_NEXT_PRODUCTION_ORIGIN` verified its compiled agent and Workflow rewrite destinations; a direct Next rewrite delivered the two events together, which is why the ingress bypass is required. A second local check put the real production Next server behind the ingress with an Eve-shaped mock and passed page/API, health, callback and live SSE requests. These tests do not prove a deployed owned model turn. In split mode, Next's `/api/health/ready` checks application data; monitor Eve's `/eve/v1/health` through the ingress separately, then run the post-deployment `--agent` smoke and replacement tests before release.

## Maintainer-managed Vercel + Supabase

Before linking a project, run `npm run test:vercel-build` in a checkout without `.env.local`. It builds Next in Vercel mode, runs the generated Eve service build command, and checks the daily cron configuration, public agent route, Workflow callback, Node 24 runtime and streaming metadata. This is a credential-free local build contract; it does not create a Vercel project, apply migrations, test hosted Supabase or prove a deployed agent turn.

With the intended managed runtime settings in the operator shell or private `.env.local`, run `npm run check:managed-config`. It reuses the application's data/Auth/chat validators and requires explicit HTTPS origins, Supabase as both the application data and identity provider, an explicit chat switch, the default Vercel Workflow world, and a strong `CRON_SECRET` for the scheduled cleanup route. Use `npm run check:managed-config -- --require-chat` when the release must support owned agent turns; also run `npm run check:budget-policy` to inspect its attributed quote. These commands make no network request, link no project and cannot validate key validity, migration state, Auth redirects, current provider prices or runtime reachability. Follow them with migration preview/review and the post-deployment smoke below.

1. Provision a separate Supabase project per environment/organization. Set its private `DATABASE_URL`, review `npm run db:migrate -- --dry-run` and a restorable backup, then apply `npm run db:migrate` from one release job.
2. Configure Vercel with `DATA_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AUTH_PROVIDER=supabase`, `SUPABASE_PUBLISHABLE_KEY`, `APP_ORIGIN`, `CRON_SECRET` and appropriate model credentials. `APP_API_KEYS` is optional for administrator-issued API/CLI/MCP credentials. To enable private upload quarantine, also set `UPLOAD_STORAGE_PROVIDER=supabase` after applying migrations and provisioning the private bucket as described in [uploads](uploads.md); no quarantined file can be downloaded. The Unix-socket scanner is for self-hosted processes and is not a managed Vercel scanning service. Follow [account setup](authentication.md) for SMTP and redirect URLs. Separate Preview and Production secrets.
3. Use `npx eve link --non-interactive --project NAME` and `npx eve deploy --non-interactive --yes --project NAME`. `withEve` generates the integrated service output.
4. Keep `EVE_WORKFLOW_PROVIDER` unset/default for the managed Vercel world. Configure opt-in [account chat](account-chat.md), then verify web liveness, data readiness, authenticated cross-user API/MCP access and a real owned agent turn.

Account chat is disabled by default. When enabled, signed creation and verified browser ownership form the exclusive policy, with no local-development or OIDC fallback. See [agent session access](agent-session-access.md).

The committed `vercel.json` runs the protected [upload cleanup trigger](uploads.md) daily at 02:00 UTC in Production. Set a strong server-only `CRON_SECRET` even for a records-only deployment; after authorization, the route acknowledges the schedule without touching data or object providers when upload storage is disabled. If uploads are enabled, set `UPLOAD_STORAGE_PROVIDER=supabase`, provision the private bucket and monitor failed batches and `more` responses. Drain stale uploads before disabling storage, because cleanup cannot remove their objects while its backend is unconfigured. Preview deployments do not run Vercel Cron. The offline preflight verifies the secret's shape, not Vercel's live schedule or delivery.

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

This explicit mode runs the two-account data smoke, creates one conversation for the first user, waits for its durable owner binding, checks that the second user cannot read its metadata, stream, projections or source-event view, and requires a completed Eve model step, turn, nonempty response and captured application projections. It then reads the retained source stream through the application API with the first user's token, checks absolute cursor progress and confirms a completed run and assistant response. It does not retry creation or send a follow-up. The conversation, usage and provider charge remain on the first account; use disposable staging users and inspect the printed operation ID if the run times out. A passing result proves that one turn and its source read worked at that deployment, not canonical model history, replay after replacement, every tool, or a fixed invoice ceiling.

Add `--browser` to any of these commands after installing Playwright's Chromium (`npx playwright install chromium`). For example, `npm run smoke:hosted -- --accounts --browser` uses the same two tokens to open the deployed `/records` page in a clean browser, read the temporary record, reconnect after reload, then switch to the second token and verify that the record disappears. It exercises hydration and the browser-to-API path without a model call. With Vercel Deployment Protection, the bypass secret is sent as a browser request header; it is never put in the URL. Browser mode does not prove signup, email delivery or an authenticated chat UI turn.

All modes check web/data/Eve health, the records page, anonymous denial, cross-owner list/read/edit/delete denial, and one owner's REST, CLI and MCP reads of a temporary record. The command deletes that record even if a later check fails. A lost create response can still leave a record behind; the command prints its unique title for manual review and never retries the write. It rejects remote HTTP and redirects. The `--accounts` mode proves server-side token acceptance and owner isolation without a model call; `--agent` additionally proves one owned turn and a paged, owner-only source read. `--browser` adds a Chromium record read, reload and owner-switch check. These modes do not prove the browser signup/email flow or workflow replay after replacement. Run those acceptance cases separately before release. For a protected Vercel deployment, export its automation bypass secret as `VERCEL_AUTOMATION_BYPASS_SECRET` in the operator shell; the smoke sends Vercel's [recommended header](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation) on web, REST, CLI, MCP and Eve requests. Keep this secret out of URLs and logs.

## AWS / Azure / GCP / Amplify

The [cloud container recipes](cloud-containers.md) include ECS/Fargate, Azure Container Apps and Cloud Run definitions with a packaged streaming ingress, managed secret references, remote application data and PostgreSQL workflows. Runtime replacement/replay is tested locally with the compiled PostgreSQL world; `npm run test:workflow-compose` also checks the combined two-database container stack and app replacement. Cloud control-plane validation and deployed acceptance remain pending. A local workflow world requires persistent storage and one instance. PostgreSQL workers require continuously available CPU, a private workflow database and explicit migrations.

Amplify compatibility remains blocked by the currently documented Next.js version and streaming support: this app uses Next.js 16.3.5, while [AWS Next.js support](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-amplify-support.html) documents versions through 15 and excludes Next.js streaming (checked 2026-09-25). [Node 24 is supported](https://docs.aws.amazon.com/amplify/latest/userguide/ssr-supported-features.html), but that does not resolve either mismatch. A separately hosted Eve service does not itself resolve the web-side mismatch. See the explicit gate in the cloud recipes; no Amplify deployment is certified.

For split services, use the streaming ingress above. The cloud container examples include this route; their external load balancers still require deployed SSE acceptance. The installed `withEve` appends a private service prefix to Next's internal rewrite destination, and the rewrite buffered a two-event SSE fixture locally. Do not expose that rewrite as the public chat path. Complete a real owned turn and Workflow callback through the deployed ingress; platform recipes remain incomplete until those checks pass.
