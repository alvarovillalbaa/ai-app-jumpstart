# Application data

`RecordRepository` owns record storage; `RecordService` owns its validation and authorization. `ConversationHistoryService` provides owner-scoped metadata reads and edits through the shared session-access store. REST, MCP, CLI and the browser share these services. Records are a reference domain; conversation metadata is not a message/run projection or a complete application schema.

## Credentials

Run `npm run auth:key -- TENANT SUBJECT read` (or `write`). Put the returned configuration array in server-only `APP_API_KEYS`; give the token to the client. Tokens contain 256 bits of randomness and only SHA-256 digests are configured. Each entry binds fixed tenant, subject and scopes. Removing an entry revokes it after configuration reload/redeployment. Rotate by temporarily provisioning both entries.

Send `Authorization: Bearer TOKEN` over HTTPS. When `AUTH_PROVIDER=supabase`, a current user access token is also accepted after verification against Supabase Auth; see [account setup](authentication.md). A Supabase secret or publishable project key is never an application token. Client payloads cannot choose owners or scopes. Browser Origins must match `APP_ORIGIN`. These data endpoints require explicit bearer credentials and do not use ambient cookies. Account conversation access additionally requires enabled [account chat](account-chat.md) and a verified registered-user token; record API keys never grant it, even with matching owner strings. Runtime session operations use the separate [session authorizer](agent-session-access.md).

## REST

| Operation | Request | Response |
| --- | --- | --- |
| List | `GET /api/v1/records?limit=25&after=UUID` | `{items,nextCursor}` |
| Read | `GET /api/v1/records/UUID` | Record |
| Create | `POST /api/v1/records` with `{title,content}` | 201 + Record + Location |
| Update | `PATCH /api/v1/records/UUID` with `{title,content,revision}` | Record with next revision |
| Delete | `DELETE /api/v1/records/UUID?revision=1` | 204 |

Records have `id`, `title`, `content`, `revision`, `createdAt`, `updatedAt`; owner fields never leave the repository. Lists sort by ID, with 1–100 items per page. Pagination is not a snapshot under concurrent writes. Titles are 1–200 characters, content at most 32,000 characters, and request bodies at most 128 KiB. Unknown fields fail validation.

Responses are `no-store`. Errors are `{error:{code,message,requestId}}`, with an `X-Request-Id` header and correlated structured log. Missing reads return 404. Unavailable/stale/other-owner mutations share 409 to avoid disclosing ownership. Unexpected provider errors are redacted. Create is not idempotent: do not retry ambiguous failures automatically. Update/delete reject stale revisions.

The structured editor can save reviewed fields as a normal private record. Its `content` is a versioned `structured-draft` JSON envelope with the source operation ID and typed values. REST, CLI and MCP record commands access the same row. The editor validates that envelope and the source owner's conversation on reopen; generic record writes can make a draft incompatible, in which case the editor shows an error. A lost create response may have committed, so inspect account records before retrying.

Conversation metadata uses `GET /api/v1/conversations`, `GET /api/v1/conversations/OPERATION_UUID/metadata`, and `PATCH /api/v1/conversations/OPERATION_UUID`. The metadata read returns the same summary as listing, including title, archive flag and revision; it excludes session IDs, request hashes and owner fields. The existing GET without `/metadata` remains the creation-status lookup for the chat UI. See [history semantics and upgrade steps](account-chat.md#conversation-history).

## CLI

Set `APP_API_TOKEN` and optionally `APP_API_URL` in `.env.local`, then:

```sh
npm run app -- list
npm run app -- create ./record.json
npm run app -- get RECORD_UUID
npm run app -- update RECORD_UUID ./replacement.json
npm run app -- delete RECORD_UUID 2
```

Use `npm run --silent app -- list` for JSON pipelines. Files contain the REST payload. The CLI rejects remote HTTP, follows no redirects, retries no writes, and exits nonzero on failures. Credentials are never command arguments. For a protected Vercel deployment, an optional `VERCEL_AUTOMATION_BYPASS_SECRET` environment value is sent as an HTTP header to the configured `APP_API_URL`; set it only for the intended Vercel target.

A current registered-user token can read selected Supabase Auth profile fields at `GET /api/v1/account/profile`, `npm run app -- account profile`, or the MCP `account_profile` tool and `account:///profile` resource. The snapshot includes contact addresses, account timestamps, linked provider names and user-editable metadata. It excludes credentials, sessions, MFA factors, provider identity details and arbitrary server-controlled Auth metadata. User metadata is exported as data and never grants application permissions. API keys, anonymous accounts and revoked tokens cannot read the profile.

For conversation metadata, set `APP_API_TOKEN` to a current registered-user access token and run:

```sh
npm run app -- conversations list --limit 20
npm run app -- conversations list --archived --cursor CURSOR_FROM_PREVIOUS_PAGE
npm run app -- conversations get OPERATION_UUID
npm run app -- conversations update OPERATION_UUID ./conversation-patch.json
```

An update file contains `{"revision":1,"title":"New title"}`, `{"revision":1,"archived":true}`, or both fields. Use `archived:false` to restore. Omit the cursor for the first page and preserve the archive filter between pages. A stale revision returns a nonzero error; read current metadata before editing again. Tokens are short-lived; the CLI does not implement login or refresh and never stores them. Supply a fresh token after expiration. Commands manage metadata only and do not dispatch model work, cancel runs or delete transcripts.

### Export visible application data

With a record read token, download all owner-scoped records. With a current registered-user token and account chat enabled, download the selected account profile plus records, conversation metadata, selected stream projections, saved artifacts, active private-upload metadata, budget reservation and owner-visible correction histories, and both upload and AI usage snapshots:

```sh
mkdir -p .data
npm run app -- export records .data/records-export.ndjson
npm run app -- export application .data/application-export.ndjson
```

The command reads existing authenticated REST pages and writes newline-delimited JSON. The first line is a versioned `manifest` (`ai-app-jumpstart-visible-data-v5`), each following line has a `type` and `value`, and the final `end` line has counts. Application mode writes one `account_profile` line before owner-scoped records. It pages until each available collection ends, including archived conversations and each conversation's projections. The upload section records all active catalog entries in their current `pending`, `quarantined` or `deleting` state, followed by one `upload_usage` line. Paged `budget_reservation` lines include each admission timestamp, policy, estimate, status and nullable actual cost; `null` means cost is unknown even after settlement. Paged `budget_correction` lines include the affected operation, previous and corrected cost, and correction timestamp; operator notes and evidence references are omitted. The output is mode `0600` and is published only after all reads succeed; it never replaces an existing file. Keep the file private and outside version control. Each page is a live read, so concurrent changes may appear or be missed; a nonadvancing cursor or more than 10,000 pages for one collection fails without publishing a partial file. A failed or expired token also fails the export.

This is an **application-visible data export**, not a complete account export or backup. Quarantined upload bytes are never included or made downloadable by this command. It also omits deleted upload tombstones and derived data, the rest of the Supabase Auth user record, credentials, linked identity details, sessions and MFA factors, Eve's model history or workflow checkpoints, budget model-attempt IDs, operator correction notes/evidence and historical daily aggregates, deleted artifact tombstones, provider logs and database backups. Projections contain selected captured events, not a canonical transcript. The manifest lists these omissions so recipients do not mistake the file for complete erasure or a compliance-grade snapshot. Full export and deletion still require coordinated provider/runtime retention work.

## MCP

Point an MCP client at `https://YOUR_HOST/api/mcp` with the bearer header. The official SDK implements stateless Streamable HTTP. GET streams and DELETE sessions return 405. Tools are `records_list`, `records_get`, `records_create`, `records_update`, `records_delete`. Resources use `records:///UUID`. Both share REST permissions. Mutation annotations inform client approval UI; they do not grant authorization. Interactive OAuth discovery/registration is not implemented.

This server exposes application data, not administrative database tools. Outbound Eve MCP connections and an agent-as-MCP channel remain distinct future work.

With a verified user token and account chat enabled, the same endpoint also registers `conversations_list`, `conversations_get`, `conversations_update`, and `conversations:///OPERATION_UUID` resources. List arguments are `{limit,archived,cursor}`; get accepts `{operationId}`; update accepts `{operationId,patch:{revision,title?,archived?}}`. At least one editable field is required. These expose the same metadata and revision behavior as REST/CLI. These metadata tools do not expose transcripts or runtime identifiers. The additional `conversations_events` and `conversations_source_events` tools expose the selected [persisted and read-through stream views](conversation-projections.md). `conversations_reconcile` repairs the persisted view from the owner-authorized Eve stream, resuming from its durable checkpoint unless given a source index. Identity is reverified for every stateless request, including resources and tool discovery. Record keys and disabled account-chat deployments have no conversation tools/resources; cached tool names do not bypass that check. Caller metadata cannot select the credential type or owner.

## Storage

PostgreSQL/Supabase migration enables RLS and denies public/browser table access. The server credential can bypass RLS and must remain private; repository operations also scope every statement by tenant and subject. Browser SDK access to these tables is unsupported. Apply migrations with a database owner role; runtime roles need the appropriate table permissions. Never give clients the database credential.

SQLite initializes on first access and supports one persistent instance. Remote databases are migrated explicitly by `npm run db:migrate` with `DATABASE_URL`; a transaction and advisory lock serialize migration jobs. Add a new adapter by implementing the full repository contract and passing `tests/contracts/records.ts` unchanged.

Selected finalized message/run events are readable through `GET /api/v1/conversations/OPERATION_UUID/events`, CLI `conversations events OPERATION_UUID [AFTER_INGESTION_INDEX]`, and MCP `conversations_events`. These are versioned stream projections with ingestion-order pagination and an optional verified `sourceIndex` after replay. The owner-only `/reconcile` endpoint, CLI `conversations reconcile OPERATION_UUID [START_SOURCE_INDEX]`, and MCP `conversations_reconcile` repair missed writes and annotate matching captured events without dispatching model work; the CLI and MCP resume from the durable checkpoint by default. A separate `GET /api/v1/conversations/OPERATION_UUID/source-events`, CLI `conversations source-events OPERATION_UUID [START_SOURCE_INDEX]`, and MCP `conversations_source_events` read the retained Eve stream in absolute source order with bounded cursors. Both views can contain interrupted attempts; neither is canonical model history. See [projection semantics and source-order reads](conversation-projections.md).

Private plain-text artifacts have owner-only read surfaces at `GET /api/v1/artifacts?limit=20&cursor=...`, `GET /api/v1/artifacts/ARTIFACT_UUID`, CLI `artifacts list|get`, MCP `artifacts_list`/`artifacts_get` and `artifacts:///ARTIFACT_UUID`. Owners can download text at `GET /api/v1/artifacts/ARTIFACT_UUID/download` and erase a saved copy through `DELETE /api/v1/artifacts/ARTIFACT_UUID`, CLI `artifacts delete` or MCP `artifacts_delete`. A verified user token and enabled account chat are required. There is no REST/CLI/MCP artifact-create operation; the [approved Eve tool](approved-artifacts.md) owns creation and durable call-ID idempotency.

The current [AI usage view](usage-budgets.md) is readable at `/usage`, `GET /api/v1/usage`, CLI `usage`, MCP `usage_get` and `usage:///current`. Historical reservations are paged at `GET /api/v1/usage/reservations?limit=50&cursor=...`, CLI `usage reservations --limit 50 --cursor ...`, and MCP `usage_reservations`. Owner-visible cost corrections use the corresponding `/api/v1/usage/corrections`, CLI `usage corrections` and MCP `usage_corrections` reads. These all use the verified account owner; record API keys do not grant budget access. Values are application reservations and settlements, including conservative unknown-cost estimates. History pages are live reads rather than a transaction snapshot.
