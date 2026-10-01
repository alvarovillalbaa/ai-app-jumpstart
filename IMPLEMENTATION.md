# AI app jumpstart — implementation specification

Prepared: 14 September 2026. Audience: the template maintainer and a coding agent implementing it. This is the original target specification; [current delivery status](docs/DELIVERY.md) tracks verified implementation and remaining work.

## Status and scope

This is a domain-neutral application foundation, not a vertical product and not a completed production application. The accompanying `bootstrap-ai-app.sh` describes the original scaffolding process and writes initial integration files. At the time this specification was prepared, its shell syntax was checked but dependency installation, TypeScript compilation, the application build and runtime tests had **not** been executed. Those statements are historical; see [delivery status](docs/DELIVERY.md) for current local verification. Do not rerun the bootstrap over this implemented repository.

The bootstrap installs Next.js, shadcn/ui, AI Elements, Eve, Supabase clients/CLI, Cuelume, theme/toast/form helpers, and test/format/deploy tooling. It creates a minimal setup page, a muted-by-default sound provider, a read-only arithmetic tool, Eve/Next configuration, a deliberately closed Eve channel, test configuration, environment examples, an empty CLI-created migration, and an installed-version manifest.

The original bootstrap alone did **not** implement authentication, session authorization, persistence, MCP integrations, account settings, uploads, budgets or deployment. Those remain implementation requirements below; some are now implemented in this repository and others remain open. The bootstrap's empty migration is not a finished schema. Basic smoke tests do not certify missing capabilities.

## 1. Architectural decisions

Use a single Next.js App Router repository, TypeScript, Tailwind and one coherent shadcn component base. Radix is the chosen base for this foundation (opinion). Do not install another application framework or a second orchestration system merely to reproduce capabilities already present.

Use `withEve` from `eve/next` to integrate the application and runtime. Use `useEveAgent` from `eve/react` for the reference conversation UI. AI Elements supplies rendering and interaction components, not persistence or application authorization. Adapt Eve's message types deliberately; do not force them into AI SDK `UIMessage` through unsafe casts. [S1–S5]

Supabase owns authentication, application tables, ownership/permissions, private file storage and application projections. Eve/Workflow owns execution and replay. A Supabase project is not automatically an Eve checkpoint store. Keep checkpoint persistence and the application database as explicitly different concerns. [S5–S8]

Use user-owned resources by default. Team workspaces, billing, RAG, scheduled jobs, public sharing, voice, code execution and multiple agents are optional modules, not mandatory dependencies of the baseline (opinion).

Use one reference chat, one structured-output form and one approval-gated local artifact action to demonstrate reusable patterns. Do not write prompts, schemas, pages or fixtures about HR, recruiting, sales or any other industry.

## 2. Commands: running the foundation

Keep both downloaded files outside the empty repository until the script finishes. For example, save them in Downloads, open a terminal in the existing `ai-app-jumpstart` directory, and run:

```bash
node --version
npm --version
git --version
bash "$HOME/Downloads/bootstrap-ai-app.sh"
cp "$HOME/Downloads/IMPLEMENTATION.md" ./IMPLEMENTATION.md
```

Use Node.js 24.x. Current Eve requires Node >=24; this foundation deliberately standardizes on 24.x. With Homebrew already installed, a macOS upgrade path is:

```bash
brew install node@24
export PATH="$(brew --prefix node@24)/bin:$PATH"
node --version
```

Persist that PATH change in your own shell configuration or use your existing Node version manager. Do not install two competing version managers. Docker must be installed and running for local Supabase. [S3, S9]

The script refuses nonempty directories other than `.git` and `.DS_Store`, does not touch a GitHub remote, and never commits, pushes, creates a remote Supabase project or deploys. Do not rerun it in a partially generated project: inspect the failed command, resolve the cause, and continue from that point.

### Dependency commands used by the script

These are included for inspection, not a second sequence to run after the bootstrap:

```bash
npx --yes create-next-app@latest . \
  --typescript --tailwind --eslint --app --src-dir \
  --use-npm --import-alias '@/*' --no-react-compiler --disable-git --yes

npm install --save-exact \
  eve@latest ai@latest zod@latest \
  @supabase/supabase-js@latest @supabase/ssr@latest \
  cuelume@latest server-only next-themes sonner lucide-react \
  react-hook-form @hookform/resolvers

npx --yes shadcn@latest init --defaults --base radix
npx --yes shadcn@latest add \
  button input textarea label card dialog alert-dialog dropdown-menu \
  avatar separator sheet sidebar tabs tooltip skeleton badge scroll-area \
  select switch checkbox table popover command progress --yes
npx --yes shadcn@latest add \
  @ai-elements/conversation @ai-elements/message @ai-elements/prompt-input \
  @ai-elements/tool @ai-elements/confirmation @ai-elements/attachments \
  @ai-elements/sources @ai-elements/reasoning @ai-elements/model-selector \
  @ai-elements/suggestion @ai-elements/artifact --yes

npm install --save-dev --save-exact \
  supabase vercel vitest @vitejs/plugin-react vite-tsconfig-paths jsdom \
  @testing-library/react @testing-library/jest-dom @testing-library/user-event \
  @playwright/test @axe-core/playwright \
  prettier prettier-plugin-tailwindcss eslint-config-prettier tsx
```

Do not resolve dependency conflicts with `--force` or `--legacy-peer-deps`. Inspect the installed Eve package's peers and choose a compatible version set. Commit the lockfile and the installed-version manifest after the complete integration passes. Template consumers run `npm ci`; they do not rerun the `latest` bootstrap. [S1–S4]

### Local database and environment

This section records the original bootstrap workflow. The implemented app now uses the root `migrations/` directory and `npm run db:migrate` for SQL, with current runtime variables in `.env.example`; follow [databases](docs/databases.md) and [hosting](docs/hosting.md) for setup. Do not run the bootstrap-era `supabase migration up` commands against this repository.

```bash
docker info
npx supabase start --help
npx supabase start
npx supabase status
```

The bootstrap has already run `supabase init` and `supabase migration new initial_schema`. Edit the CLI-generated migration rather than inventing a timestamped filename. Populate `.env.local` from the local status output and your model account:

| Variable | Meaning | Exposure |
|---|---|---|
| NEXT_PUBLIC_APP_URL | Application origin | Public |
| NEXT_PUBLIC_SUPABASE_URL | Supabase project/API URL | Public |
| NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY | Publishable project key | Public |
| SUPABASE_SECRET_KEY | Privileged backend key, used only in narrow repositories | Server only |
| AI_GATEWAY_API_KEY | AI Gateway credential | Server only |
| AI_MODEL | Model ID enabled in the selected Gateway account | Server only |
| EVE_INTERNAL_SIGNING_SECRET | Key for signed internal creation requests, when implemented | Server only |

Some local CLI configurations report legacy `anon` / `service_role` keys. They can fill the corresponding public/backend roles locally; prefer current publishable/secret keys for hosted projects. Never confuse those two roles. A publishable key is expected to be public; security comes from authorization policies, not hiding that key. [S7–S9]

Generate an internal random secret without placing its value into shell command history:

```bash
node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'
```

Paste the output into the server-only variable; do not commit it. A secret string alone does not implement signing, expiry, request binding or replay protection.

After implementing and reviewing the schema:

```bash
npx supabase migration up --help
npx supabase migration up --local
npm run db:types
npx supabase db lint --local
# After database test files have been added:
npx supabase test db
```

Only for a disposable local test database, `npx supabase db reset --local` rebuilds it from migrations and destroys its existing data. Never present this as a routine production deploy step. [S9]

### Development and validation

```bash
npx playwright install chromium
npm run check
npm run test:e2e
npm run build:local
npm start
```

For development instead of the last two commands:

```bash
npm run dev
```

`build:local` explicitly builds Eve before Next.js. Vercel's integrated build uses `withEve` services; do not blindly run an independent second deployment. Local production testing and Vercel build topology are not identical. [S5]

## 3. Target file structure

A target path is an implementation requirement, not a claim the bootstrap created it.

```text
agent/
  agent.ts
  instructions.md
  channels/eve.ts
  channels/home.ts
  channels/mcp.ts                     # optional inbound MCP, authenticated
  tools/add_numbers.ts
  tools/create_artifact.ts
  connections/reference.ts            # optional, disabled without configuration
  skills/                              # only enable loaders intentionally
  instrumentation.ts
src/
  app/
    layout.tsx
    page.tsx
    (auth)/login/page.tsx
    (auth)/signup/page.tsx
    (auth)/forgot-password/page.tsx
    (auth)/update-password/page.tsx
    auth/callback/route.ts
    auth/confirm/route.ts
    (app)/app/layout.tsx
    (app)/app/page.tsx
    (app)/app/chat/[conversationId]/page.tsx
    (app)/app/playground/page.tsx
    (app)/app/artifacts/page.tsx
    (app)/app/connections/page.tsx
    (app)/app/settings/page.tsx
    api/conversations/route.ts
    api/conversations/[conversationId]/route.ts
    api/conversations/[conversationId]/start/route.ts
    api/uploads/route.ts
    api/usage/route.ts
    api/health/route.ts
    error.tsx
    not-found.tsx
  proxy.ts
  components/
    ui/
    ai-elements/
    providers/
  features/
    auth/
    agent/                            # typed render adapters + useEveAgent boundary
    conversations/
    artifacts/
    connections/
    settings/
  config/app.ts
  config/features.ts
  config/models.ts
  lib/
    env/client.ts
    env/server.ts
    supabase/browser.ts
    supabase/server.ts
    supabase/admin.ts
    security/auth.ts
    security/ownership.ts
    security/internal-signatures.ts
    security/origin.ts
    security/redirects.ts
    security/url-policy.ts
    repositories/
    budgets/
    logging/
  types/database.ts
supabase/
  config.toml
  migrations/
  tests/
  seed.sql
examples/
  mcp/
  workspaces/
  retrieval/
evals/
tests/unit/
tests/integration/
tests/e2e/
docs/
  architecture.md
  configuration.md
  adding-a-tool.md
  adding-an-mcp-connection.md
  deployment.md
  security.md
  troubleshooting.md
  installed-versions.txt
.github/workflows/ci.yml
.github/workflows/deploy.yml
.github/dependabot.yml
README.md
AGENTS.md
SECURITY.md
CONTRIBUTING.md
LICENSE
.env.example
```

## 4. Implementation work packages

### 4.1 Configuration and application shell

Create `app.ts` for name, description, links, logo and navigation. Keep feature configuration separate from per-user entitlements: hiding a button is not authorization. Add public and server environment schemas; missing configuration should produce an actionable setup error without dumping secrets.

Implement a responsive sidebar, mobile navigation, breadcrumbs, account menu, light/dark/system themes, keyboard focus states, skeletons, empty states, not-found pages and error recovery. Keep product content in configuration rather than in copied JSX across screens. Replace the setup page only when the reference flows actually work.

Do not show model pickers, connectors, upload buttons or billing controls that have no functioning backend. Either implement them or visibly disable/hide the optional capability. No successful-looking mock data in the production path.

### 4.2 Supabase authentication

Implement browser and request-scoped server clients using the current SSR integration. Add `src/proxy.ts` for session refresh and correct response-cookie propagation. Verify identity server-side with the documented validated identity methods, not by trusting cookie-derived `getSession()` output. Recheck auth in handlers and server mutations; a protected layout is not an API security boundary. [S7]

Provide login, logout, signup, email confirmation, password recovery and session-expired behavior. OAuth providers are configuration-gated extensions. Validate return paths against a same-origin allowlist; do not accept arbitrary `next` URLs. Configure actual site URLs and callback URLs in Supabase for each environment.

Do not cache authenticated HTML/API responses across users. Log out safely, clear user-specific client caches, and handle a second account signing in in the same tab.

Never authorize with user-editable `user_metadata`. Keep service/secret-key clients outside browser-importable modules. Next.js server-only helpers must not be imported into Eve's independent runtime if they depend on `next/headers`; share framework-neutral contracts and use runtime-specific adapters. [S7–S8]

### 4.3 Database schema and row-level authorization

Use migrations as the source of truth. The baseline tables should be:

| Table | Minimum responsibilities |
|---|---|
| profiles | Account display fields, not a duplicate authentication system |
| user_preferences | Theme, sound enabled/volume, safe UI preferences |
| conversations | App UUID, owner, title, archive state, server-bound Eve session ID |
| messages | Versioned, renderable message-part projections and deterministic IDs |
| agent_runs | Session/turn references, status, timestamps, model and error code |
| usage_events | Append-only reported usage with source and idempotency key |
| budget_reservations | Atomic pre-dispatch reservations and reconciliation status |
| tool_executions | Stable call key, input hash, approval state and effect result |
| uploads | Private object path, owner, media type, byte count and processing state |
| artifacts | Owner, source run, safe content/type, version and file reference |
| connections | Account-owned integration metadata and credential reference; no plaintext tokens |

Eve IDs are strings, not necessarily UUIDs. Use `text` for framework session/run identifiers. Keep application UUIDs independent. Use timestamps, foreign keys and indexes matching ownership/list queries. Add composite relationships or equivalent constraints so a child cannot claim one user while referring to another user's parent. [S6]

Enable RLS on all exposed tables and explicitly grant only the intended operations. New-table access is not safely inferred from historical Supabase defaults. User-editable display fields must be distinct from server-owned session bindings, usage totals, message roles and run status. A user must not be able to attach their row to somebody else's Eve ID or fabricate an assistant message. [S8–S10]

For a directly owner-scoped table, the update-policy shape is:

```sql
create policy "owner_updates" on public.user_preferences
for update to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);
```

Also supply the SELECT policy needed for UPDATE, intentional column grants and the other required operations. This example is not a whole schema. Privileged backend access bypasses RLS: its repository functions must still enforce a verified owner or trusted execution principal. Do not solve permission errors by broadly adding SECURITY DEFINER. Views exposed through the API need security-invoker semantics or an equally deliberate boundary. [S8]

Delete/export flows coordinate database rows, active agent work, storage objects, connection credentials and runtime retention. Deleting a conversation row alone does not delete all provider/runtime copies.

### 4.4 Eve session ownership — release blocker

The ordinary Eve HTTP channel authenticates callers but does not establish the application's per-session ACL. Supabase RLS does not protect Eve's HTTP event streams. Enforce permissions in the Eve channel boundary, not only Next.js proxy middleware; the integrated Vercel routes reach Eve before filesystem routing. [S5–S6, S11]

Required creation design (opinion):

1. A Next.js server endpoint verifies the Supabase identity and creates/loads an owner-scoped application conversation and a durable creation-operation record.
2. The server initiates Eve session creation with a signed internal request carrying the verified user context. The signer binds method, path, request-body hash, operation ID, timestamp and nonce. The verifier enforces a short lifetime and replay policy. Both services receive the signing secret privately. A browser bearer token alone cannot use this privileged creation path.
3. The Eve channel returns a user principal derived from the verified context, not an arbitrary body `userId`. Save the canonical returned Eve session ID into the server-owned mapping.
4. Return the usable session mapping to the browser only after it is durable. Creation remains in a recoverable `starting` state if the mapping write fails. A reconciliation task repairs or cancels orphaned starts; it must not silently create new work each time.
5. Every continuation, event-stream, approval response, cancel, compact, clear and reset request validates the current caller and checks the existing mapping. Missing, deleted or other-owner mappings fail closed. Return consistent non-enumerating errors.

Use Eve's authenticated creation `operationId` where supported, plus a database uniqueness/lease strategy. It is not a cross-service transaction: concurrent candidate IDs and startup timing require reconciliation to the canonical operation result. Do not claim a simple `create; insert` sequence is exactly-once. [S6]

The browser may obtain its own current Supabase access token and attach it through `useEveAgent` request headers. That token must be verified by the runtime. Do not store it in prompts, event payloads or durable state and assume it remains valid after a long wait. Re-evaluate current account/membership policy before side effects.

Audit task-input routes, information endpoints and authorization callbacks as separate surfaces. Preserve the framework's required signed callbacks without opening arbitrary runtime access.

### 4.5 Durable execution and persistent UI

Use the Eve hook as the source of live conversation state. Persist stable application projections from server-side channel/runtime events, with upserts keyed by stable event/message/run IDs. Never make the browser's `onFinish` callback the only persistence mechanism: users can close the tab. Batch persistence at meaningful boundaries rather than writing each token.

Reloading a conversation reattaches its owned session and replays/follows the event stream. Reconnection deduplicates previously processed events, notifications and sounds. A reconciliation path recovers missed projections. Persist schema versions so future Eve upgrades can migrate old message formats.

Distinguish stopping a live turn, clearing model context, retiring a session, deleting the application's history and opening a new chat. Cancelling is cooperative; display pending cancellation until a terminal boundary is observed. Unmounting a component must not be presented as server cancellation. [S6, S12]

Treat external side effects as retryable executions, not guaranteed exactly-once functions. Use a stable call ID plus input hash and provider idempotency keys where available; store the execution result so replays can return it. Reserve explicit reconciliation/manual recovery for services that cannot make a side effect idempotent.

### 4.6 AI Elements and the reference screens

Implement typed renderers for user/assistant text, safe Markdown/code, attachments, tool state, approvals, sources and errors. Render only model/provider-supplied reasoning summaries intended for display; do not invent or expose hidden internal chain-of-thought. Provide copy/retry controls, durable stop, timestamps, pending reconnect state and accessible announcements. [S4, S12]

Map Eve statuses to component props explicitly; for example, Eve's resuming state is not automatically an AI SDK ChatStatus. Handle unsupported message parts visibly during development, safely in production, and cover the mapping with tests. Avoid unsafe type coercion to make the two libraries appear compatible.

Provide three reference flows:

- Conversation: plain response, the arithmetic tool and reconnect after a refresh.
- Structured output: a schema-validated generic result displayed as editable fields or a table, independent of chat.
- Approved action: propose creating a private generic artifact, show the exact payload, approve/deny, then persist once. No real email, payment or external write is required to demonstrate the pattern.

Model selection comes from a server-maintained allowlist with capabilities and deployment configuration. A browser must not choose arbitrary provider endpoints, system prompts, unrestricted tools or budget ceilings.

### 4.7 Tools and human approval

Each authored tool has a validated input schema, narrow description, output contract, ownership check, timeout, size bound, structured error mapping and test cases. Include an approval policy for consequential operations. The approval describes the exact side effect and is bound to its inputs, owner and current state.

Recheck authorization after waiting for approval, and invalidate approval when inputs change. Denial must be a first-class outcome. Do not permit client editing of approval state in Supabase. Keep sensitive arguments out of model-visible schemas when the application can supply them from verified context.

The foundation disables optional Eve defaults. Only reintroduce needed tools intentionally. Connections can still enable the framework's connection-search mechanism, so review what connected tools become discoverable. Do not add shell, filesystem, browser or sandbox access simply because a framework supports it. [S13]

### 4.8 MCP: three separate integrations

**Runtime client:** use Eve's native connection definitions to call an allowlisted MCP server. Supply a bounded read-only reference integration or a local development fixture; it is disabled when unconfigured. Support connection status, expired credentials, reconnect and disconnect. Select allowed tools, conservative approvals, timeouts and response limits. Per-user credentials require per-user credential resolution and account isolation, not one environment token pretending to be individual user access. [S14]

**Inbound MCP server:** optional `agent/channels/mcp.ts` exposes the application agent using Eve's MCP channel. Require authenticated invocations and scoped capabilities. Its MCP invocation ownership behavior is distinct from the ordinary Eve HTTP session API discussed above. Interactive OAuth needs a real authorization-server/client-registration design; wrapping a verifier does not issue tokens or make arbitrary identity flows compatible. [S15]

**Developer MCP:** an optional example configuration for a coding agent to inspect a disposable Supabase development project. Never give the application's production agent unrestricted Supabase management MCP, production SQL or developer deployment permissions.

Validate configured URLs, require HTTPS outside loopback development and block private-network/metadata destinations and dangerous redirects. Prefer a curated connector registry. Prompt instructions are not an SSRF or permission control. Store credentials encrypted or in a managed secret facility and reference them by non-secret identifiers; do not put credentials in user-visible connection rows, URLs, logs or LLM context.

Use native Eve facilities first. Do not install a second runtime MCP client library or generic server framework unless the required behavior is not covered.

### 4.9 Uploads, artifacts and optional retrieval

Use private storage buckets. Enforce owner-scoped object paths and Storage policies, not just database-row policies. Validate actual file bytes, allowed media types, maximum size, quotas and extraction state; don't trust filenames or client MIME headers. Provide upload progress, failure/retry and deletion.

Generate short-lived, authorized download links. Treat HTML/SVG and active previews carefully; do not render uploaded active content on the authenticated application origin. Add scanning/quarantine as an explicit deployment requirement for supported file classes. Never attach raw bytes from another user's path based on a client-supplied URL.

Retrieval is an extension with document versions, content hashes, chunk ownership, asynchronous ingestion, embeddings configuration, deletion and tenant-filtered retrieval tests. Do not enable public vector search or ingest every upload automatically.

### 4.10 Costs, rate limits and observability

Add application-level per-user limits for active runs, request frequency, attachment sizes and daily spending. Reserve budgets atomically before dispatch and reconcile actual usage afterward. Bound model output, tool loops and retries. Conservative reservations need to account for the configured model and possible tool/provider costs; reported cost is not always complete.

Eve's built-in cost/token settings are soft runtime thresholds checked after calls, and can allow user-approved continuation. They are not a hard contractual business budget. The application must independently reject unaffordable work and unauthorized budget increases. [S16]

Record request ID, app conversation ID, session/turn ID, tool-call ID, event ID, model, durations, outcome, token usage and the source of cost estimates. Redact prompts, access tokens, connection credentials and attachments by default. A missing model-reported price should be `unknown`, not zero.

Add separate liveness/readiness health checks, user-safe error codes, trace correlation, retry policies and alertable failures. Do not return stack traces or configuration secrets to users. Operational telemetry providers are replaceable adapters rather than a prerequisite for local development.

### 4.11 UI sounds and accessibility

The supplied provider wraps Cuelume's actual `bind`, `play`, `setEnabled` and `setVolume` APIs. The package has no preference persistence; the application supplies it. Start muted, allow explicit opt-in, persist the preference, bound the volume and tolerate blocked browser audio. Cuelume synthesizes feedback rather than requiring a folder of audio assets. [S17]

Use sparse sounds for confirmed actions, errors or completion. Never play on every token, replayed historical event, hover across a dense navigation UI or background reconnect. Make sound optional and pair every cue with an accessible visual/text state. Respect reduced motion separately; it is not equivalent to sound preference.

When cross-device preferences are added, define whether server or device preferences win and test hydration without overwriting the stored choice. Do not serialize audio objects into global app state. Avoid adding another sound library.

### 4.12 Application-wide security

Validate trusted origins on cookie-authenticated state-changing requests and use the framework's CSRF protections correctly. Keep CORS closed unless there is a deliberate cross-origin client. Treat origin checks, authentication, session authorization and tool permissions as different layers.

Define security headers and a Content Security Policy compatible with the actual rendering components; do not claim a strict policy while broadly allowing executable user content. Bound request bodies, avoid unsafe HTML rendering, validate redirect destinations, and never fetch arbitrary attachment or connector URLs without the shared URL policy. Model inputs may need server-authorized short-lived file access; do not assume a private Storage URL can be fetched by every provider.

Account export and deletion, credential revocation, log redaction and runtime retention must be documented. Treat regenerated or edited conversation branches carefully: retrying a turn that already performed a side effect is not just a visual action.

### 4.13 Test suite and quality gates

The supplied tests are only setup checks. Expand them into:

| Layer | Required coverage |
|---|---|
| Unit | Validation, model allowlists, message adapters, idempotency keys, budget logic, safe return URLs |
| Components | Composer behavior, tool results, approval/denial, error recovery, keyboard accessibility, muted preferences |
| Database | Two users, owner isolation, insert/update tampering, no forgeable server fields, private storage |
| Runtime integration | Missing/invalid/expired token, session ownership on all operations, signed creation, orphan recovery, reconnect |
| E2E | Signup/login/logout, create/reopen conversation, tool call, approval, artifact, upload, another account, stop/reload |
| Failure cases | Provider 429/5xx, expired connector, database write failure, network loss, duplicate callback, malicious tool output |
| Evals | Schema correctness, proper tool choice, refusal of unauthorized actions, prompt-injection containment, calibrated uncertainty |

Regular CI uses deterministic model fixtures or a controlled mock provider. Maintain separate optional, budgeted real-provider smoke tests/evals; a PR must not spend unlimited model credits or depend on nondeterministic prose matching. Do not silently bypass tests with missing environment variables. Account separation requires real RLS tests, not a mocked repository always returning the current user.

Pin GitHub Actions by reviewed commit SHA, use read-only permissions unless required, isolate untrusted PRs from deployment secrets and database admin credentials, and cache dependencies using the lockfile. Never automatically execute repository-controlled migrations against production for arbitrary PR code.

### 4.14 Deployment, migration ownership and operations

Choose one deployment owner. A custom deployment workflow and Vercel's automatic Git deployment must not both race to release the same commit. Use a serial environment-specific path: checks, migration review/dry run, additive migration, application deployment, authenticated runtime smoke test, rollback decision.

Use separate staging and production Supabase projects and Vercel projects/environments. For the first deployment, separate projects are the clearest safety boundary (opinion): Vercel documents that a new project's first deployment is production even when `--prod` is omitted. Never assume omission means safe preview. [S18]

The bootstrap-era Supabase CLI and `NEXT_PUBLIC_*` deployment examples are superseded by the implemented application. Its SQL source is `migrations/`, applied by the repository's transaction/ledger runner rather than `supabase db push`. For the intended **staging** project's private migration connection:

```bash
npm run db:migrate -- --dry-run
# Review the pending SQL and a restorable backup, then:
npm run db:migrate
```

Set `DATABASE_URL` to that staging connection in the release job, not in a browser bundle. The dry run is read-only and lists pending files; it does not prove the SQL will succeed. Rebuild a disposable database from zero and test an upgrade from the previous release. Use expand/contract changes. Deploying an older app does not undo database migrations. Maintain backup/restore and restore-test instructions. [S9, S19]

Configure an explicitly separate **staging** Vercel project. The current runtime reads `APP_ORIGIN`, `DATA_PROVIDER=supabase`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AUTH_PROVIDER=supabase` and `SUPABASE_PUBLISHABLE_KEY` from the server environment. Set `SUPABASE_AUTH_URL` only if Auth uses a different origin. Enable account chat only after configuring the reviewed `AI_BUDGET_POLICY_JSON`, shared `AI_CREATION_SIGNING_JSON` and `AI_CHAT_ENABLED=true`; see `.env.example` and [hosting](docs/hosting.md). Browser-safe Auth settings are passed at request time; the old `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `AI_MODEL` and `EVE_INTERNAL_SIGNING_SECRET` names do not configure this implementation. Vercel AI Gateway can use project OIDC; direct/local paths may require `AI_GATEWAY_API_KEY`.

Use Eve's integrated project workflow from the repository root, selecting the staging project and team explicitly:

```bash
npx eve link --non-interactive --project YOUR_STAGING_PROJECT
npx eve deploy --non-interactive --yes --project YOUR_STAGING_PROJECT
```

These are production-target commands for the selected staging project, not authorization to deploy the real production project. Use Node 24.x and configure Supabase site and callback URLs for the real staging origin. Repeat with explicitly selected production project references only after acceptance tests pass. Confirm both the web UI and authenticated Eve service, not just a green web build. [S5, S18–S19]

### 4.15 Template distribution and upgradeability

The finished README must support two paths: clone + local Supabase, and clone + hosted Supabase. Document every required secret, each optional feature, exact validation commands, safe reset instructions and common errors. Add focused recipes for a new tool, model, connection, schema change and UI route.

Ship `.env.example`, generated database types, deterministic seed fixtures, a tested lockfile, release tags, upgrade notes, a security reporting policy and a chosen LICENSE. Do not imply every bundled dependency shares the template's license; preserve required notices. Never include personal account IDs, production keys, example users with real identities or application-specific branding.

Mark the repository as a template only after the documented new-user setup has been rehearsed from a clean clone. Future upgrades require regenerating components in a branch, reviewing diffs and running the full suite; do not overwrite customized AI Elements/shadcn files blindly.

## 5. Delivery order and definition of done

Implement in this order: configuration and schema; auth and runtime ownership; persistent conversation; reference tool and approval; structured result/artifact; upload and optional MCP; operational controls; full tests/docs/deployment. Keep the runtime closed until the identity/ownership/budget path exists.

A publishable baseline must pass these checks:

1. Fresh clone, pinned install, environment setup and migrations work without hidden manual edits.
2. Missing configuration shows actionable setup errors and never exposes secrets.
3. User B cannot list, read, stream, mutate, approve, cancel, compact, clear or reset User A's resources.
4. A lost create response can be reconciled without uncontrolled duplicate work or an unowned accessible session.
5. Refresh/closed-tab recovery preserves completed messages and durable execution without replaying notifications.
6. Denied/expired approvals and exhausted budgets cannot be bypassed through direct API requests.
7. Replayed tool execution cannot silently repeat the reference side effect.
8. Private uploads and connector credentials cannot be retrieved across accounts.
9. Auth, tools, cancellation, persistence, file handling and errors work on the actual deployed Eve service, not just a browser mock.
10. CI can run without real user credentials or paid model calls; budgeted integration smoke tests are separately documented.
11. Sounds are optional and never the only feedback; keyboard and screen-reader flows remain usable.
12. Every enabled button works, every disabled extension is identified, and the README has been tested by following it literally.

## Sources reviewed

Upstream APIs may change after the review date. Check the installed versions before adapting examples. Source addresses are retained here for future maintenance.

```text
S1  Next.js CLI: https://nextjs.org/docs/app/api-reference/cli/create-next-app
S2  shadcn CLI: https://ui.shadcn.com/docs/cli
S3  Eve package: https://raw.githubusercontent.com/vercel/eve/main/packages/eve/package.json
S4  AI Elements setup: https://elements.ai-sdk.dev/docs/setup
S5  Eve + Next.js: https://raw.githubusercontent.com/vercel/eve/main/docs/guides/frontend/nextjs.mdx
S6  Eve HTTP channel: https://raw.githubusercontent.com/vercel/eve/main/docs/channels/eve.mdx
S7  Supabase SSR: https://supabase.com/docs/guides/auth/server-side/creating-a-client
S8  Supabase RLS: https://supabase.com/docs/guides/database/postgres/row-level-security
S9  Supabase CLI: https://supabase.com/docs/reference/cli/introduction
S10 Supabase changelog: https://supabase.com/changelog
S11 Eve auth: https://raw.githubusercontent.com/vercel/eve/main/docs/guides/auth-and-route-protection.md
S12 Eve frontend: https://raw.githubusercontent.com/vercel/eve/main/docs/guides/frontend/overview.mdx
S13 Eve default tools: https://raw.githubusercontent.com/vercel/eve/main/docs/concepts/built-in-tools.md
S14 Eve MCP connections: https://raw.githubusercontent.com/vercel/eve/main/docs/connections/mcp.mdx
S15 Eve MCP server: https://raw.githubusercontent.com/vercel/eve/main/docs/channels/mcp.mdx
S16 Eve agent configuration: https://raw.githubusercontent.com/vercel/eve/main/docs/agent-config.md
S17 Cuelume: https://github.com/Danilaa1/cuelume
S18 Vercel deployment CLI: https://vercel.com/docs/cli/deploy
S19 Supabase environments: https://supabase.com/docs/guides/deployment/managing-environments
S20 Vercel environment CLI: https://vercel.com/docs/cli/env
```
