# AI App Jumpstart

A Next.js 16 / React 19 application with integrated Eve and a portable application-data layer. **Node 24.15.0 or newer 24.x** is required; `.nvmrc` selects the tested version and npm rejects unsupported Node versions. The root app is canonical; `my-agent/` is a preserved legacy scaffold.

This template is under active implementation. Reference records work through the browser, REST, CLI and MCP, with optional Supabase accounts. Workspace screens share responsive, keyboard-accessible navigation and a browser-persisted system/light/dark theme choice; optional chat links appear only when account chat is enabled. Opt-in [account chat](docs/account-chat.md) uses a signed creation broker, durable ownership and runtime budget admission; it is disabled by default. Enabled chat requires an attributed cost basis checked against its reservation. [Delivery status](docs/DELIVERY.md) records remaining release requirements, including current provider-price review and operational reconciliation.

Enabled account chat includes private conversation history at `/conversations`, with rename, archive/restore and transcript reopening. Metadata uses the selected application database and is also accessible through REST, CLI and MCP with verified user credentials; live transcript replay uses Eve's separate workflow storage. Selected finalized messages/run boundaries also have portable [stream projections](docs/conversation-projections.md), with a saved-activity browser view, API/CLI/MCP reads and bounded replay recovery.

The opt-in [structured output reference](docs/structured-output.md) at `/structured` uses the same ownership and budget path to generate editable, schema-validated fields. It can reload the generated result by operation ID or save reviewed fields as a versioned private record that reopens for editing.

The [approved artifact reference](docs/approved-artifacts.md) proposes a private plain-text artifact in chat, shows its exact input for approval, saves it once, and lists owned results at `/artifacts`. Owners can download or erase the saved copy; owner-scoped reads and deletion also work through REST, CLI and MCP.

The [AI usage view](docs/usage-budgets.md) at `/usage` shows the account's current UTC-day charges, reservations and limit. The same owner-scoped snapshot is available through REST, CLI and MCP; it is an application budget view rather than a provider invoice. Operators can use the read-only [outstanding-start inventory](docs/operations.md) and an audited [settled-cost correction](docs/operations.md#correct-an-already-settled-cost) from a source checkout with backend credentials.

## Start locally

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

Open `http://localhost:3000/records`, enter the token, and create a record. Tokens stay in tab memory; reload requires reconnecting. For browser signup and login, enable the independent Supabase identity provider and open `/account`; see [authentication](docs/authentication.md). Local chat at `/` additionally needs model credentials.

For a local production process, run `npm run build:local` then `npm start`. The local build compiles both Eve and Next. `npm run test:vercel-build` checks the generated Vercel-mode Next/Eve service graph without a linked project or credentials. A local build is not proof of a successful hosted agent turn.

## Shared data access

- Browser: `/records`.
- REST: `/api/v1/records` and `/api/v1/records/{id}`.
- CLI: `npm run app -- help`; configure `APP_API_TOKEN` and optionally `APP_API_URL` in `.env.local`.
- MCP: `/api/mcp`, Streamable HTTP with the same bearer token; CRUD tools and `records:///UUID` resources.

All share validation, owner isolation, scopes, pagination and revision checks. With account chat enabled, verified user tokens also unlock conversation metadata through `/api/v1/conversations`, CLI `conversations` commands and MCP `conversations_*` tools/resources. See [data access](docs/data-access.md).

Opt-in private upload quarantine uses `/uploads` in the browser, `/api/v1/uploads`, CLI `uploads` commands and MCP metadata tools. A self-hosted ClamAV socket can reject infected files before storage. Quarantined files remain unavailable to the agent; a separate opt-in scan-on-read policy permits owner downloads only after a fresh clean verdict. See [uploads](docs/uploads.md).

The CLI can also create a private, paged [export of visible application data](docs/data-access.md#export-visible-application-data) for an owner. Its manifest lists data held by Auth, Eve and other systems that the export does not include.

## Storage and hosting

| Option | Configuration / status |
| --- | --- |
| SQLite | `DATA_PROVIDER=sqlite`; one persistent instance; [consistent private backup command](docs/operations.md) |
| PostgreSQL / managed PostgreSQL | `DATA_PROVIDER=postgres`, `DATABASE_URL`; adapter, migrations, contract tests and a [private archive/restore rehearsal](docs/operations.md) |
| Supabase PostgREST | `DATA_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`; migrated project required |
| Convex | `DATA_PROVIDER=convex`, `CONVEX_SITE_URL`, `CONVEX_BACKEND_SECRET`; internal functions behind an authenticated HTTP action |
| Self-hosted Node / Docker | `build:local`, supervised Eve + Next startup; SQLite restart/API/MCP/CLI and deterministic owned-chat browser contracts verified in the image; [streaming Compose overlay](compose.streaming.yaml) and [offline snapshot/restore](docs/local-recovery.md) |
| Split Next and Eve services | [Streaming ingress recipe](docs/hosting.md#split-next-and-eve-behind-one-streaming-ingress) and Docker route/SSE fixture check; deployed owned-turn acceptance pending |
| Maintainer-managed Vercel + Supabase | Offline runtime-configuration preflight and Eve deployment recipe; production acceptance pending |
| AWS ECS / Azure Container Apps / GCP Cloud Run | [Container definitions and recipes](docs/cloud-containers.md) with an offline filled-manifest preflight; PostgreSQL workflow restart and dual-database Compose proofs passed locally; cloud acceptance pending |
| AWS Amplify | Documented Next.js version/streaming incompatibility with the current app; compatibility gate remains open |

Run `npm run db:migrate -- --dry-run` with the target `DATABASE_URL` to review pending SQL, then run `npm run db:migrate` after backup review and before PostgreSQL/Supabase use. Remote migrations never run per request. SQLite is not for ephemeral serverless or shared network filesystems. Application data and Eve workflow storage are separate; self-hosted PostgreSQL deployments can create a [stopped two-database recovery set](docs/postgres-recovery.md) and rehearse both restores.

Read [database setup](docs/databases.md), [hosting](docs/hosting.md), [operations](docs/operations.md), and [testing](docs/testing.md).

The [extension recipes](docs/extending.md) show where to add a tool, model, connection, schema change or UI route. The [private upload guide](docs/uploads.md) describes the quarantine browser/API/CLI/MCP surface, opt-in self-hosted owner downloads, and remaining managed release and agent-attachment work.

## Validate

```sh
npm run typecheck
npm run lint
npm test
npm run test:providers
npm run test:postgres-backup
npm run test:workflow-postgres
npm run test:ai
npm run build:local
npx playwright install chromium
npm run test:e2e
npm run test:container
npm run test:chat:container
npm run test:workflow-compose
```

`test:ai` uses a dedicated fixture model through Eve's real runtime with no paid model calls. `eval:live` exercises the unchanged production model and requires credentials. `test:providers` starts isolated real PostgreSQL, PostgREST and Convex services without hosted accounts. Run `test:integration` against a disposable configured PostgreSQL/Supabase/Convex backend; missing configuration fails explicitly. Reuse `tests/contracts/records.ts` for new providers.

After deployment, run the provider-neutral [`smoke:hosted` check](docs/hosting.md#post-deployment-data-smoke) with two temporary record credentials. For enabled Supabase accounts, run its `--accounts` mode with two distinct signed-in users. Add `--browser` to verify the deployed records UI in Chromium. These modes verify the web, agent, REST, CLI and MCP surfaces without a model call; `--agent` explicitly adds one owned turn.

On a reviewed staging account, `--agent` additionally verifies one authenticated model turn and cross-user stream denial; it can incur provider charges.

## License

Original template code is licensed under [MIT](LICENSE). Copied AI Elements and shadcn/ui components retain their upstream terms; see [third-party notices](THIRD_PARTY_NOTICES.md). Installed dependencies have separate licenses.
