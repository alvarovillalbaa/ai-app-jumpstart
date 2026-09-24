# Extend the template

Keep the root app as the owner of frontend, agent and data contracts. Check the installed Next guide under `node_modules/next/dist/docs/` before adding a route or page, and start with `node_modules/eve/docs/README.md` before changing agent behavior. The versions in this repository can differ from online examples.

## Add a tool

For a generic, bounded capability, add `agent/tools/<name>.ts` using `defineTool` and a Zod input schema, following `agent/tools/calculate.ts`. Put reusable logic in `agent/lib/`, test it without the model, then exercise the agent through `npm run test:ai`. An external side effect needs a deliberate approval policy and owner check; `agent/tools/create_artifact.ts` shows the approval and durable same-call write pattern. Read Eve's installed `tools/overview.mdx` and `tools/human-in-the-loop.md` before coding. Default tools are disabled in `agent/agent.ts`; do not enable broad tools as a shortcut.

## Choose a model

`agent/agent.ts` owns the Eve model ID. Read the installed `agent-config.md`, change that ID intentionally, then review the allowed IDs and actual input/output prices in `AI_BUDGET_POLICY_JSON` before enabling account chat. Run `npm run build:eve`, `npm run test:ai`, and a credentialed `npm run eval:live` in the intended environment. The deterministic eval uses a fixture model and cannot certify a new paid model's output or cost. For a content-only identity or response-style edit, change `agent/instructions.md` and leave the model ID alone.

## Add a connection

Search Eve's registry first with `npx eve registry search <product> --json`, inspect the result with `npx eve registry view <item>`, then install with `npx eve add <item> --non-interactive` if its permissions fit. Read the installed `connections/overview.mdx` before authoring a custom connection in `agent/connections/`. Scope credentials to the intended user or service, inspect the exposed tools, and use a disposable external account for tests. Do not give the production agent database-administration or deployment access merely to implement an application feature.

## Change application data

Update the owner-aware contract in `lib/data/contract.ts`, the adapter(s) in `lib/data/`, and the service in `lib/data/service.ts`. Add an ordered SQL file to `migrations/` for PostgreSQL/Supabase, an additive SQLite upgrade, and corresponding Convex functions/schema when those providers support the feature. Keep browser writes behind server authorization; the Supabase adapter uses a backend key and the migrations deny direct browser table access. Extend `tests/contracts/records.ts` or the matching ownership/budget contract, then run `npm run check`, `npm run test:providers`, and a migration dry run against a disposable database. Apply the new migration to local Supabase and run `npm run db:types` followed by `npm run db:types:check`; commit the changed generated types. Review the SQL and backup before applying to a shared environment. The Supabase CLI migration/reset path is not this repository's canonical schema runner.

## Add a UI route

Add an App Router `page.tsx` under `app/`; private workspace screens use `app/(workspace)/` and server-side identity checks like `app/(workspace)/account/page.tsx`. Reuse `app/_components/`, the workspace navigation, metadata and error/loading conventions. If the page needs a backend endpoint, use a Next `route.ts` and the existing `lib/http/` authorization and validation service rather than connecting the browser to backend secrets. Add a meaningful DOM or browser check in `tests/frontend/` or `tests/e2e/`, then run `npm run check` and the relevant browser suite. Read the installed Next App Router page and route-handler guides before authoring those files.

## Add private object storage

Implement `PrivateUploadObjects` from `lib/uploads/contract.ts` for the selected private bucket or volume. The adapter receives a verified owner and server-generated UUID, never a client-selected object path. Run `tests/contracts/uploads.ts` unchanged against it for cross-owner and sequential replacement checks. The local filesystem adapter additionally proves exclusive concurrent publication. Supabase Storage can acknowledge two racing non-upsert writes, so only a winning `UploadCatalog.reserve` result may authorize an object write. Implement `UploadCatalog` from `lib/uploads/catalog-contract.ts` and run `tests/contracts/upload-catalog.ts` unchanged for quota, listing and state semantics. Compose them through `UploadIntake` and test the real backend race. Keep byte validation in `lib/uploads/validation.ts`; the HTTP/CLI/MCP surface stores quarantined bytes but never serves them. Complete scanning, authorized download, cleanup recovery and the user-facing lifecycle in [the upload plan](uploads.md) before exposing bytes in the UI or to Eve.
