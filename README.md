# AI App Jumpstart

A Next.js 16 / React 19 application with integrated Eve and a portable application-data layer. **Node 24.15.0 or newer 24.x** is required; `.nvmrc` selects the tested version and npm rejects unsupported Node versions. The root app is canonical; `my-agent/` is a preserved legacy scaffold.

This template is under active implementation. Reference records work through the browser, REST, CLI and MCP, with optional Supabase accounts. Workspace screens share responsive, keyboard-accessible navigation and system/light/dark themes. [Account preferences](docs/account-preferences.md) synchronize theme and optional sound settings across all four data providers while keeping a separate signed-out device choice; optional chat links appear only when account chat is enabled. Opt-in [account chat](docs/account-chat.md) uses a signed creation broker, durable ownership and runtime budget admission; it is disabled by default. Enabled chat requires an attributed cost basis checked against its reservation. [Delivery status](docs/DELIVERY.md) records remaining release requirements, including current provider-price review and operational reconciliation.

Enabled account chat includes private conversation history at `/conversations`, with rename, archive/restore and transcript reopening. Metadata uses the selected application database and is also accessible through REST, CLI and MCP with verified user credentials; live transcript replay uses Eve's separate workflow storage. Selected finalized messages/run boundaries also have portable [stream projections](docs/conversation-projections.md), with a saved-activity browser view, API/CLI/MCP reads and bounded replay recovery.

The opt-in [structured output reference](docs/structured-output.md) at `/structured` uses the same ownership and budget path to generate editable, schema-validated fields. It can reload the generated result by operation ID or save reviewed fields as a versioned private record that reopens for editing.

The [approved artifact reference](docs/approved-artifacts.md) proposes a private plain-text artifact in chat, shows its exact input for approval, saves it once, and lists owned results at `/artifacts`. Owners can edit with revision conflicts, inspect immutable version history, export every retained version, download or erase the saved copy; owner-scoped reads and deletion also work through REST, CLI and MCP.

The [AI usage view](docs/usage-budgets.md) at `/usage` shows the account's current UTC-day charges, reservations and limit. The same owner-scoped snapshot is available through REST, CLI and MCP; it is an application budget view rather than a provider invoice. Operators can use the read-only [outstanding-start inventory](docs/operations.md) and an audited [settled-cost correction](docs/operations.md#correct-an-already-settled-cost) from a source checkout with backend credentials.

## Start locally

After this repository is enabled for GitHub's **Use this template** action, set the generated project's app identity before installing dependencies or starting local Supabase. This gives the new project a distinct npm name, displayed app name, MCP server name and Supabase CLI project ID:

```sh
npm run init:template -- --name "Acme Assistant" --apply
npm ci
```

The package and Supabase IDs use the slug `acme-assistant` derived from the display name. Use `--slug your-own-slug` to choose a different lowercase, hyphen-separated ID. Without `--apply`, the command only previews the changes. It updates project identity fields and the README title; protocol names, database formats and stable API contracts remain unchanged. See [fresh-clone and hosted setup](docs/getting-started.md) before configuring providers.

For browser accounts and a Supabase-backed application, follow the [fresh-clone guide](docs/getting-started.md) for either local or hosted Supabase. The following path is the smaller SQLite/API-key example.

The guide also covers an owner-scoped, repeatable sample-record seed and generation of committed Supabase database types from the local migrated schema.

```sh
npm ci
cp .env.example .env.local
npm run auth:key -- local developer write
```

The key command prints a private token and a configuration array. Put **only the array** into `APP_API_KEYS` in `.env.local` as single-quoted JSON. Keep the token for the records screen or CLI. Never commit this output. SQLite initializes in `.data/app.sqlite` on first access.

```sh
npm run dev
```

The development server binds to loopback by default, so the local Eve chat is available only from this machine.

Open `http://localhost:3000/records`, enter the token, and create a record. Tokens stay in tab memory; reload requires reconnecting. For browser signup and login, enable the independent Supabase identity provider and open `/account`; see [authentication](docs/authentication.md). Local chat at `/` additionally needs model credentials.

For a local production process, run `npm run build:local` then `npm start`. The local build compiles both Eve and Next. `npm run test:vercel-build` checks the generated Vercel-mode Next/Eve service graph without a linked project or credentials. A local build is not proof of a successful hosted agent turn.

`npm run test:quickstart` rehearses this SQLite path from a new clone of **committed HEAD**, initializes it with a distinct sample identity, then performs a fresh install/cache, build/start, seed reruns, restart persistence, two-owner browser/REST/CLI/MCP access and deterministic AI evals. Install Chromium first with `npx playwright install chromium`. It requires macOS or Linux, uses free loopback ports and removes its own clone/services; local uncommitted changes are excluded. See [testing](docs/testing.md).

## Shared data access

- Browser: `/records`.
- REST: `/api/v1/records` and `/api/v1/records/{id}`.
- CLI: `npm run app -- help`; configure `APP_API_TOKEN` and optionally `APP_API_URL` in `.env.local`.
- MCP: `/api/mcp`, Streamable HTTP with the same bearer token; CRUD tools and `records:///UUID` resources.

All share validation, owner isolation, scopes, pagination and revision checks. Verified user tokens also unlock retained conversation metadata, saved activity, run summaries and existing artifacts through REST, CLI and MCP, even with account chat disabled. Creating or continuing chat and reading/reconciling the live Eve source still require enabled account chat. See [data access](docs/data-access.md).

Opt-in private upload quarantine uses `/uploads` in the browser, `/api/v1/uploads`, CLI `uploads` commands and MCP metadata tools. A self-hosted ClamAV socket or separately deployed authenticated HTTPS scanner can reject infected files before storage. Quarantined files remain unavailable to the agent; a separate opt-in scan-on-read policy permits owner downloads only after a fresh clean verdict. [Owner review](docs/upload-review.md) separately enables bounded UTF-8 text extraction through browser, REST, CLI and MCP after approval and a fresh scan, without sending text to the agent. The optional [Eve reader](docs/agent-upload-reader.md) can read an exact reviewed reference after a separate native approval per call. Explicit scans are available through browser, REST, CLI and MCP, with durable clean/rejected decisions; rejected IDs cannot be released by a later clean scan. An optional dedicated signing keyring enables 60-second application download links that still require the current owner credential and a fresh scan. See [uploads](docs/uploads.md) and the optional [scanner Compose stack](docs/remote-upload-scanner.md#reproducible-scanner-stack).

The CLI can also create a private, paged [export of visible application data](docs/data-access.md#export-visible-application-data) for an owner. Its manifest lists data held by Auth, Eve and other systems that the export does not include.

## Storage and hosting

| Option | Configuration / status |
| --- | --- |
| SQLite | `DATA_PROVIDER=sqlite`; one persistent instance; [consistent private backup command](docs/operations.md) |
| PostgreSQL / managed PostgreSQL | `DATA_PROVIDER=postgres`, `DATABASE_URL`; adapter, migrations, contract tests and a [private archive/restore rehearsal](docs/operations.md) |
| PostgreSQL with signed-in accounts | Real-Auth account, chat and reviewed-file browser suites run against migrated PostgreSQL application data in CI, with local and real private Supabase Storage; [commands and scope](docs/testing.md) |
| Supabase PostgREST | `DATA_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`; migrated project required |
| Convex | `DATA_PROVIDER=convex`, `CONVEX_SITE_URL`, `CONVEX_BACKEND_SECRET`; internal functions behind an authenticated HTTP action; disposable signed-in browser/agent suite in CI with local and real private Supabase Storage |
| AWS S3 private uploads | Optional `UPLOAD_STORAGE_PROVIDER=aws-s3`, region and private bucket; works with any application data provider on a Node host; [bucket requirements](docs/uploads.md#aws-s3-private-object-storage) |
| Self-hosted Node / Docker | `build:local`, supervised Eve + Next startup; SQLite restart/API/MCP/CLI and deterministic owned-chat browser contracts, plus a disposable PostgreSQL/Supabase Storage account smoke in the production image; [public HTTPS Compose overlay](docs/self-hosted-https.md), streaming ingress and [offline snapshot/restore](docs/local-recovery.md) |
| Split Next and Eve services | [Streaming ingress recipe](docs/hosting.md#split-next-and-eve-behind-one-streaming-ingress) and Docker route/SSE fixture check; deployed owned-turn acceptance pending |
| Maintainer-managed Vercel + Supabase | Offline runtime-configuration preflight and Eve deployment recipe; production acceptance pending |
| AWS ECS / Azure Container Apps / GCP Cloud Run | [Container definitions and recipes](docs/cloud-containers.md), filled-manifest preflight, [one-off migration jobs](docs/cloud-migrations.md) and [upload cleanup jobs](docs/cloud-cleanup.md); PostgreSQL workflow restart and dual-database Compose proofs passed locally; cloud acceptance pending |
| AWS Amplify self-managed | [Native Next 16 / Node 24 streaming adapter and offline CloudFormation recipe](docs/amplify-self-managed.md), actual local Lambda/browser/PostgreSQL contracts; cloud acceptance pending |

Run `npm run db:migrate -- --dry-run` with the target `DATABASE_URL` to review pending SQL, then run `npm run db:migrate` after backup review and before PostgreSQL/Supabase use. Remote migrations never run per request. SQLite is not for ephemeral serverless or shared network filesystems. Application data and Eve workflow storage are separate; self-hosted PostgreSQL deployments can create a [stopped recovery set](docs/postgres-recovery.md) containing both database archives and their local private upload files, then rehearse restoration.

Read [database setup](docs/databases.md), [hosting](docs/hosting.md), [operations](docs/operations.md), [upgrading](docs/upgrading.md), and [testing](docs/testing.md).

The [account data inventory](docs/account-data-inventory.md) classifies owner-linked tables across all four data providers, includes backend-only row and private-object inspection across the supported providers, a combined fail-closed closure observation, raw application-row and private-object exports with an optional jointly verified account bundle and isolated SQLite/local restore rehearsal, permanent backend-only application-row write fences, and the work still needed for full erasure. The [runtime retention guide](docs/runtime-retention.md) covers native purge-on-finish configuration, build/runtime checks and its limits; replayable account chat requires default retention. The [extension recipes](docs/extending.md) show where to add a tool, model, connection, schema change or UI route. The [private upload guide](docs/uploads.md) describes the quarantine browser/API/CLI/MCP surface, opt-in scanned owner downloads including the [remote scanner contract](docs/remote-upload-scanner.md), and remaining release-policy and agent-attachment work. [Authenticated request limits](docs/request-limits.md) share per-owner quotas across browser, REST, CLI and MCP on every data provider; the environment example enables 120 per UTC minute. [Runtime diagnostics](docs/runtime-observability.md) use native Eve metadata-only instrumentation, signed creation correlation and replaceable observability destinations.

## Validate

```sh
npm run typecheck
npm run lint
npm run check:docs
npm run check:openapi
npm run check:container-pins
npm test
npm run check:dependencies
npm run --silent sbom > dependency-sbom.cdx.json
npm run test:providers
npm run test:postgres-backup
npm run test:workflow-postgres
npm run test:ai
npm run build:local
npx playwright install chromium
npm run test:e2e
npm run test:container
npm run test:chat:container
npm run test:chat:uploads
npm run test:auth:postgres
npm run test:chat:postgres
npm run test:chat:uploads:postgres
npm run test:convex:accounts
npm run test:auth:supabase
npm run test:chat:supabase
npm run test:chat:uploads:supabase
npm run test:managed-quickstart
npm run test:workflow-compose
npm run test:workflow-retention
```

`test:ai` uses a dedicated fixture model through Eve's real runtime with no paid model calls. `eval:live` exercises the unchanged production model and requires credentials. `test:providers` starts isolated real PostgreSQL, PostgREST and Convex services without hosted accounts. Run `test:integration` against a disposable configured PostgreSQL/Supabase/Convex backend; missing configuration fails explicitly. Reuse `tests/contracts/records.ts` for new providers. The three base `:postgres` browser modes run the real account, chat and reviewed-upload contracts with Supabase Auth, migrated PostgreSQL application data and local private uploads; two additional modes repeat account and reviewed-file cases with real private Supabase Storage. `test:convex:accounts` runs those browser contracts against its own disposable Convex backend, repeats account and reviewed-file cases with real private Supabase Storage, and refuses a hosted Convex URL. The three `:supabase` modes run the same contracts with the Supabase application adapters against disposable PostgreSQL, JWT-verifying PostgREST and the real private Supabase Storage API. The Supabase account mode also runs the reusable live object contract and proves quarantine blocks anonymous and registered users even alongside a permissive fixture policy. These modes require Docker, Chromium and the production build, and use deterministic models without hosted credentials. See [testing](docs/testing.md).

The dependency audit gate fails on unexpected high or critical npm advisories. It currently permits one exact dev-only bundled AWS CDK finding until upstream updates the package bundle; the [dependency security note](docs/dependency-security.md) records its version and removal conditions.

After deployment, run the provider-neutral [`smoke:hosted -- --contract` check](docs/hosting.md#post-deployment-data-smoke) with two temporary record credentials. It verifies that the deployed REST contract matches the release checkout, then checks keyed create/recovery/replay/deletion and owner isolation across REST, CLI and MCP. For enabled private uploads, add `--uploads` to check two-owner metadata and deletion, or `--upload-download` to require scanner-backed exact bytes. For enabled Supabase accounts, run `--accounts` with two distinct signed-in users. Add `--browser` to verify the deployed records UI in Chromium. These modes verify the web and agent surfaces without a model call; `--agent` explicitly adds one owned turn.

On a reviewed staging account, `--agent` additionally verifies one authenticated model turn and cross-user stream denial; it can incur provider charges.

## License

Original template code is licensed under [MIT](LICENSE). Copied AI Elements and shadcn/ui components retain their upstream terms; see [third-party notices](THIRD_PARTY_NOTICES.md). Installed dependencies have separate licenses.

The optional [outbound MCP development reference](docs/reference-mcp.md) demonstrates Eve native discovery of a real read-only local catalog. Its fixed allowlist and runtime evals are independent of the inbound application-data MCP endpoint; it is disabled without development configuration.
