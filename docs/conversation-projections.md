# Conversation stream projections

Account sessions persist selected Eve runtime events in the configured application database. SQLite, PostgreSQL, Supabase and Convex share the same contract. The production hook writes after Eve has durably recorded the event, independently of a browser connection. This adds portable read access; Eve remains responsible for execution, live rendering, checkpoint history and replay.

## What is stored

Each immutable entry has `schemaVersion: 1`, its source `eventId` and emission time, `turnId`, `sequence`, an optional `stepIndex`, a typed `payload`, and a database-assigned `ingestionIndex` in read responses. A `sourceIndex` is present only after an authenticated finite replay has verified that event's absolute position in Eve's durable stream. It is stored separately from the immutable payload.

| Payload kind | Stored content |
| --- | --- |
| `message` | Accepted user text/file metadata or a finalized assistant text block; role and renderable parts; assistant finish reason |
| `run` | Running, completed, failed or cancelled boundary; failure code only |
| `tool` | Requested actions or a finalized result/status from the public stream |
| `result` | Final structured output |
| `context` | Context cleared or compacted boundary |
| `omitted` | Explicit marker when an entry would exceed 48 KiB |

Partial token/tool deltas, reasoning, authorization challenges and raw failure diagnostics are excluded. File parts retain filename, media type and optional size; URLs and raw bytes are excluded. Null assistant text produces empty parts. Tool data and structured outputs are untrusted user-visible content: consumers must render them safely and must not interpret them as instructions or executable HTML. These data can contain private conversation material and need the same retention/backup controls as the application database.

The event's identity deduplicates repeated ingestion. Reusing an ID with different content is a conflict, not an overwrite. Writes require the verified owner's active conversation binding and exact runtime session. Reads remain owner-scoped, including archived or revoked conversation metadata; revocation prevents further writes. SQL tables/RPCs and Convex internal functions remain unavailable to direct anonymous/authenticated database clients.

## Meaning and ordering

**These are stream projections, not canonical model history or proof of complete capture.** Eve can emit multiple completed blocks at the same turn/step coordinates after interrupted attempts, under different event IDs. It does not mark which attempt entered durable model history. Keep both; do not collapse content using turn/step coordinates, content equality or a guessed winner. A completed message block alone does not mean the turn completed.

Source event IDs are time-ordered but not a total order across workers. Pagination uses database ingestion order. Writes to one conversation are serialized, so a late event with an older source timestamp receives a new ingestion index and remains visible after an earlier cursor. Indices can have gaps. Recovery of missed older events appends them at the end of ingestion order; this order is **not** exact runtime stream order. Reconciliation stores verified `sourceIndex` values for newly copied events and matching previously captured events. A source index is unique per conversation; another event claiming it, or the same event claiming a different index, is a conflict. Missing indexes mean the relevant stream range was not verified, not that it was empty. Turn/step coordinates and emission times provide context but do not establish a total order or identify successful attempts.

The live UI continues using Eve's reducer and replay. A read-through source-order event view is available below; complete indexed capture with checkpoints, dedicated materialized run views and an application transcript renderer remain future work. Clearing model context does not delete these events. Archiving, cancellation, revocation and data deletion remain distinct operations.

## Read through REST, CLI or MCP

Use a current registered-user bearer token with account chat enabled. Record API keys do not grant access.

- REST: `GET /api/v1/conversations/OPERATION_UUID/events?limit=20&after=INGESTION_INDEX`. The limit is 1–50; omit `after` initially. The response is `{schemaVersion:1,source:"eve-stream",items,nextCursor}`. Feed a non-null `nextCursor` into `after`. For continued polling after the last page, retain the last item's `ingestionIndex` even when `nextCursor` is null. An empty page means no captured entries at that point, not an empty conversation.
- CLI: `npm run app -- conversations events OPERATION_UUID [AFTER_INGESTION_INDEX]`. The default page size is 20.
- MCP: `conversations_events` accepts `{operationId,options?:{limit,after}}` through `/api/mcp`. It shares the REST owner checks and response contract.

Client bodies cannot create or edit projection entries. Neither reads nor recovery dispatches a model turn. Responses are private and uncached. No runtime session IDs or owner identifiers are added to these read envelopes; payloads retain public tool-event data.

## Read selected events in source order

For an active owned session, `GET /api/v1/conversations/OPERATION_UUID/source-events?startIndex=0&limit=20` reads Eve's durable stream directly using the caller's verified account token. CLI `npm run app -- conversations source-events OPERATION_UUID [START_SOURCE_INDEX]` and MCP `conversations_source_events` with `{operationId,options?:{startIndex,limit}}` expose the same view. Record API keys and another account cannot access it. The result is `{schemaVersion:1,source:"eve-durable-stream",items,scanned,nextIndex,complete}`. Each selected entry has an absolute `sourceIndex` and the same safe, bounded projection payload defined above. Resume at `nextIndex`, even if `items` is empty: unselected stream events also advance the cursor.

One read processes at most 250 raw events, returns at most 50 selected entries and has a 20-second replay deadline. `complete:true` means the read reached the tail observed when it opened; future events can still arrive. The view requires retained, reachable Eve stream data and does not write an application projection or dispatch a model turn. It gives exact **source event order**, including interrupted attempts; it is not canonical model history or proof that a completed block was the winning provider attempt. It excludes token deltas, reasoning, raw diagnostics and file URLs. Use the persisted `/events` path for portable database reads when Eve is unavailable, and use the source view when exact stream ordering matters.

## Recover missed writes

A hook failure emits a `projection_write_failed` log with the source event ID, without content or credentials. It does not fail the original turn or retry model work. Monitor these logs. A database outage can therefore leave incomplete projections until recovery succeeds.

`POST /api/v1/conversations/OPERATION_UUID/reconcile` accepts `{}` or `{"startIndex":0}` with the owner's bearer credential. The server resolves the session from its private binding, then uses Eve's SDK against its configured runtime origin with redirects disabled. It reads a finite prefix through the tail observed when opening the stream and copies only the selected events.

Each request processes at most 250 source events with a 20-second replay deadline, plus any database call already in progress. It returns `{processed,inserted,duplicates,nextIndex,complete}`. If `complete:false`, repeat with `{"startIndex":nextIndex}`. This cursor is the absolute **Eve stream index**, distinct from a projection's database ingestion index. `complete:true` only confirms reaching that request's observed tail from the requested starting point; it does not certify earlier ranges or future events. Start at zero to repair an unknown gap.

On failure the API returns `503 projection_recovery_failed`. Earlier inserts may already have committed; retry the same starting cursor after restoring the provider/runtime. Duplicate ingestion is safe. Conflicting payloads, revoked bindings and unsupported/unstamped historical events do not silently succeed. Starting/revoked conversations cannot be recovered through this endpoint. Runtime streams must still be retained and reachable; missing/deleted upstream history requires operator investigation. The structured-result screen attempts one replay when a completed result is missing or stays pending, but background scheduling, recovery checkpoints and historical stream-version migrations remain unimplemented.

Successful replay also records each selected event's absolute source index, including a matching event that the runtime hook had already captured. The persisted `/events` response then includes that optional index while retaining ingestion-order pagination. Replay does not certify unrequested earlier ranges or future events; the view can mix indexed and unindexed rows. It does not change the model-history attribution limit above.

## Setup and validation

Run `db:migrate` before deploying PostgreSQL/Supabase code; the projection migrations are `20260922113556_conversation_projections.sql` and `20260925103000_projection_source_index.sql`. SQLite adds the source column and unique index on connection. Deploy the updated Convex schema/functions before the app. PostgreSQL's insert path locks the conversation before allocating its ingestion sequence; the Supabase invoker-security RPC uses the same binding lock. Convex increments a per-conversation sequence transactionally.

Shared provider contracts cover concurrent duplicates, immutable content conflicts, owner/session denial, cursor traversal, late older events and revoked bindings. Unit recovery tests cover bounded pages, partial write failures and repeated replay. `test:chat` checks server-side capture of real compiled Eve events, owner-only reads and idempotent recovery through production Next, plus CLI/MCP access. Models remain deterministic in these tests. They do not prove hosted durability, complete attempt attribution or retention compliance.
