# Usage budgets

`lib/budgets/` implements a server-only reservation ledger across SQLite, PostgreSQL, Supabase PostgREST and Convex. `BudgetedCreation` composes it with the conversation broker. The production receipt hook enforces runtime admission and settlement for account-owned turns and compaction. [Account chat](account-chat.md) wires browser/API creation and exposes owner-only usage snapshots through `/usage`, REST, CLI and MCP. It is disabled by default; reviewed cost envelopes and reconciliation of outstanding/disputed starts remain incomplete.

## Admission

The server supplies an immutable operation ID and request hash, an estimated maximum cost, a policy ID, a daily limit, an active-run limit and a rolling one-minute request limit. Amounts are integer micro-USD: 1,000,000 units represent one US dollar. Browser request bodies contain only the message and operation ID; they cannot set prices, limits or usage.

Reservation checks and writes are atomic. Identical retries return the original reservation without charging again. A different owner, request hash, quote or policy ID cannot reuse it. Quota failures occur before dispatch. Provider errors and invalid estimates also fail closed. The creation wrapper reserves capacity before calling the durable conversation coordinator, so a retry can recover a crash between budget admission and conversation reservation without charging twice.

`now` is a trusted server clock input, not client data. Day boundaries use UTC. Hosts should have synchronized clocks. Active reservations remain active across midnight; their eventual charge belongs to the admission day. The rolling request count includes accepted requests after they settle, so finishing quickly cannot bypass the rate limit.

## Settlement and uncertainty

Only trusted server code may settle a reservation after observing the execution outcome. Known cost replaces the estimate, even if it exceeds it. An overage remains visible and can block later work; the ledger never clips reported usage to the quote. A verified zero cost is explicit `0`. Unknown cost is `null`: it charges the estimate conservatively and increments `unknownCosts`.

Identical settlement retries are idempotent. A conflicting later settlement is rejected, preventing duplicate refunds or silent history rewrites. An operator can correct an **already-settled** amount through the backend-only [reconciliation command](operations.md#correct-an-already-settled-cost). The operation compares the exact previous cost (including `unknown`), updates the charged total atomically and appends an immutable actor/reason/evidence audit row. The correction ID makes a lost-response retry idempotent. It does not reconcile a reservation that is still outstanding.

Timeouts, dropped responses, revocation and elapsed time alone do not refund capacity. A runtime may already have accepted work. There is no automatic expiration of outstanding reservations. An authenticated owner may explicitly cancel a `starting` conversation before runtime binding; that atomic transition prevents a later model call and settles the reservation at verified zero. A budget-only reservation is first fenced by a matching conversation tombstone, so a delayed broker cannot dispatch it. An active binding wins the race and cannot be refunded this way. A failed budget write after successful revocation leaves capacity reserved until idempotent retry or operator reconciliation. Disputed starts and settlements still need operator investigation; the creation broker never blindly redispatches them.

The daily admission limit bounds recorded usage plus reserved estimates. It is not a guarantee about a provider invoice. Estimation must account for the allowed model, context size, output limits, tool calls and runtime retries. Pricing provenance, runtime cost collection and complete per-turn integration are still required before enabling production chat. Missing provider prices must remain unknown.

## Persistence and access

SQLite uses an immediate transaction and a persistent WAL database. PostgreSQL serializes mutations on an owner account row; a single database function performs the admission or settlement transaction. Supabase calls the same function through PostgREST. It uses [`SECURITY INVOKER`](https://supabase.com/docs/guides/database/functions), an empty search path, RLS and explicit grants. Browser `anon` and `authenticated` roles cannot read/write ledger tables or execute the function. Runtime backend credentials stay private.

Convex uses serializable internal mutations and per-owner/day aggregates. Its authenticated backend HTTP action is the only network entrypoint. It does not scan an entire history to calculate daily usage. No browser-facing ledger mutation or refund endpoint exists.

The operator-only `npm run starts:inspect -- list` command pages outstanding reservations across all owners and joins each page with current conversation state and model-attempt counts. It uses backend database credentials directly and has no public REST or MCP route. See [operations](operations.md) for pagination and interpretation. SQL providers index reserved rows by creation time and operation ID; Convex uses the equivalent index. The inventory is read-only and nontransactional. `npm run budgets:reconcile -- show` displays one owner's reservation and its latest 100 correction entries; `correct` requires an explicit `--apply` to mutate a settled amount. The full audit log stays in the application database.

The read-only `/usage` screen calls `GET /api/v1/usage` with the current registered user's bearer token. CLI `npm run app -- usage`, MCP `usage_get` and the `usage:///current` resource use the same owner-scoped view. It shows the UTC day, charged and reserved micro-USD, daily limit, active reservations, requests in the last minute and unknown-cost settlements. The screen clears prior values on account change or a failed refresh. Record API keys cannot access this account budget view. Its dollar rendering keeps six decimal places so small test and development amounts remain visible; it is an application ledger, not a provider invoice.

Apply SQL migrations with `npm run db:migrate`; Convex deploys its schema and functions normally. Keep ledger history when restoring data: restoring only application conversations can erase reservations and permit duplicate admission.

## Runtime enforcement

`agent/hooks/session-access.ts` uses `RuntimeBudgets` and Eve's durable `defineState` context. The first turn uses its signed creation operation; later turns derive a stable operation ID from the owner, session and runtime turn ID. Every model call claims a durable attempt before reaching the provider. Eve retries re-emit events under new event IDs, so they consume additional attempts. Replaying an identical claim is idempotent; claims after settlement or past the call cap fail. Lowering a deployment call cap can tighten existing turns; increasing it cannot widen their admitted cap.

Automatic compaction consumes a call from the active turn's envelope. Manual compaction gets its own reservation. Eve's compaction completion does not report cost, so it settles conservatively as unknown. Completion, failure and cancellation settle a turn when sufficient evidence is available. Attempts missing from restored workflow usage totals prevent a refund: the ledger count is compared with completed usage reports. Partial overages with missing costs, or costs outside the ledger's supported range, remain reserved for explicit reconciliation.

Configure `AI_BUDGET_POLICY_JSON` privately with these fields:

| Field | Meaning |
| --- | --- |
| `policy.id` | Version of the reviewed cost policy |
| `policy.dailyMicros` | Daily recorded-plus-reserved allowance |
| `policy.maxActive` | Maximum outstanding operations across days |
| `policy.maxPerMinute` | Accepted operations in a rolling minute |
| `estimateMicros` | Reviewed maximum envelope for one turn or manual compaction |
| `maxModelCalls` | Maximum provider attempts, including retries and automatic compaction |
| `modelIds` | Exact runtime model IDs covered by the envelope |

There is no default price or allowance. Review full input/output bounds, retries and the selected provider before configuring an envelope. The root agent disables Eve's default tool set and exposes the authored tools; its model selection remains unchanged. Paid tools or additional agents need their own cost admission before being enabled. Development sessions using Eve's local authenticator do not enter this application-owned budget path.

## Verification and remaining work

The shared `budgetContract` runs on all four providers. It exercises concurrency, idempotency, owner-isolated reservation lookup, bounded cross-owner inventory pagination, daily and active limits, the rolling minute boundary, settlement, audited correction, unknown costs, overages, midnight behavior and durable attempt caps. SQLite also tests independent connections, reopening persisted data and the operator CLI. Supabase tests direct table and RPC denial with real database roles. Creation tests cover dispatch denial, ambiguous acceptance, a crash between budget and conversation writes, delayed-dispatch fencing during budget-only cancellation, and provider failure.

The real Eve fixture verifies owned follow-ups, manual compaction settlement, daily-limit denial, tool-loop call caps and a queued forged approval that does not produce another model call or enlarge the budget. It uses a fresh temporary app/queue namespace and the actual production hook. The account browser contract checks the usage screen and REST/CLI/MCP parity with a real authenticated user after quota exhaustion, then checks another account sees zero. It also proves budget-only cancellation in a disposable ledger. Remaining work includes reviewed provider price/envelope configuration, disputed-start reconciliation beyond owner cancellation and deployed acceptance. These local checks do not certify every optional tool, agent, callback or provider configuration.
