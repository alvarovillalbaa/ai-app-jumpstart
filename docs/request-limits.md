# Authenticated application request limits

Set `APP_REQUESTS_PER_MINUTE` to a canonical decimal integer from `1` to `10000`. The environment example enables **120** requests per verified owner per UTC minute. An unset value or `0` disables admission for existing installations. Empty values, leading zeros, fractions and whitespace fail configuration validation. Use the same setting on every application instance.

The quota belongs to the authenticated `(tenant, subject)`, not a token, browser, IP address or request body. Rotated keys for the same owner share it. REST, CLI and MCP share one persistent counter through the selected SQLite, PostgreSQL, Supabase or Convex data provider. Separate owners have independent counters. Every admitted HTTP request counts once, including MCP initialization, notifications, polling and export pages; it is not a per-record or per-tool allowance. Authenticated requests that later fail scope, body or business validation still count. Invalid credentials do not count.

Admission runs after identity verification and before reading the application body or doing the business operation. At capacity, the server returns HTTP `429`, public code `request_limit`, a server-generated request reference and `Retry-After` from 1 to 60 seconds. A denied request does not consume another slot. Provider failure or an invalid provider response returns `503` / `request_limit_unavailable` and does not execute the operation. The CLI preserves the code and reference; it does not automatically retry writes. Clients should respect the delay and the operation's idempotency rules.

Windows start at UTC minute boundaries using the provider's clock (the application clock for SQLite). Claims are atomic across connections and remote application instances. This fixed-window policy can permit twice the configured count near a boundary; it is not a rolling-minute or concurrency limit. Lowering the setting does not erase the existing count. A backwards clock does not refill a retained window. Keep backend clocks synchronized; the bounded delay may need repeating if a retained window is in the future.

## Scope and activation

The limit covers authenticated records, uploads, preferences, registered-user profile, conversation creation/history/projections/artifacts, source reads, reconciliation and usage endpoints, including their application MCP/CLI transports. It does not cover public pages, health probes, signup/login/email recovery, invalid credentials, internal scheduled endpoints or Eve/Workflow transport. Existing Eve session authorization and budget admission remain separate. Anonymous/IP abuse limits must be configured at the Auth provider and deployment edge.

Eve follow/stop controls and the REST **Cancel pending start** endpoint remain available after the data quota is spent. Cancellation still verifies the owner and uses the existing binding race and budget-settlement rules. A quota does not authorize access or prove a run had no cost.

Before enabling a SQL deployment, apply `20260927180000_request_limits.sql` through the serial [migration process](databases.md). Deploy the updated schema and internal functions first for Convex. SQLite initializes its table on connection; continue using one instance on durable local storage. `/api/health/ready` performs a read-only limiter table/function check when the setting is enabled, without claiming an owner's slot. A missing migration or inaccessible limiter fails the data readiness check.

The AWS ECS, Azure Container Apps and Cloud Run examples use `120`; their manifest preflight accepts an explicit `0` or a valid literal limit. Native Amplify authoring uses `requestsPerMinute` (default `120`, explicit `0` to disable), which becomes the same server environment variable. Configure it explicitly for a managed Vercel release. No quota storage uses ephemeral Lambda/Vercel memory.

## Operations and data

Monitor `429` separately from `503` and inspect safe request references in [application logs](operations.md). Review polling/export volume before tuning the cap. Readiness checks schema access, not a real write or hosted capacity; perform the deployment's authenticated acceptance checks too. Disable with `0` only as an intentional operator choice, since it removes application admission.

Storage retains one row per observed owner: tenant, subject, window timestamp and admitted count. It stores no token, IP, body or request transcript. SQL RLS and grants deny anonymous/authenticated roles direct reads and function execution; Supabase service-role access and Convex's private backend dispatcher enforce server-side use. Counters are not usage costs or an invoice. They are currently omitted from owner exports, and a complete account-erasure policy remains open. Database backups include these rows; apply the deployment's retention/access policy to backups too.

## Verification

Reusable provider contracts check concurrent claims, owner isolation, policy changes, input rejection and readiness without consumption. SQLite additionally checks exact rollover, backwards clocks, connection sharing and restart persistence. HTTP tests use the MCP SDK and REST/CLI paths, verify rejected operations do not reach business logic, and check safe failure responses. The pending-start route test verifies cancellation with an exhausted quota while preserving authentication, foreign-owner denial and zero-cost settlement of an unbound start. The native Amplify rehearsal checks compiled owner counters, REST/CLI/MCP rejection with `Retry-After`, unchanged record counts and an independent second owner. These are disposable local/CI checks, not hosted traffic or cloud acceptance.
