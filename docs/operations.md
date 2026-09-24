# Operations

`/api/health/live` proves the web process responds. `/api/health/ready` checks the application database/schema and, when `npm start` supervises a co-located Eve process, its loopback health route. The startup supervisor sets this topology automatically; split-service and Vercel deployments report the application data check only and must monitor Eve separately. Readiness does not certify Auth configuration, model credentials, Workflow database operations or a completed agent turn. Check `/eve/v1/health` separately and complete a real agent turn.

Data requests emit generated request ID, method, status and duration. Logs omit bodies, credentials, identities and URLs. Collect these JSON events in platform logs. Enabled account chat has durable daily, active-run and per-minute budget admission; general API rate limiting, distributed tracing and alerting remain pending.

Next-served pages and APIs set `nosniff`, `no-referrer`, frame denial, restricted camera/geolocation/microphone permissions, and CSP rules for `base-uri`, `object-src` and `frame-ancestors`. The current CSP does not restrict scripts or styles: a nonce-based policy needs a separate audit of Next hydration, the theme script and rendered AI content. Do not describe it as a complete XSS policy. Verify headers on the Eve service and at each deployment edge separately, since integrated Vercel service routing can bypass Next's response configuration. Set HSTS at a TLS-terminating ingress only after the intended hosts consistently serve HTTPS.

Run remote migrations in one release job, never per request. For PostgreSQL/Supabase, set the intended private `DATABASE_URL`, inspect `npm run db:migrate -- --dry-run`, review the migration SQL and take a restorable backup before running `npm run db:migrate`. The dry run is read-only and does not prove the SQL will apply; rehearse a provider snapshot or `pg_dump` restore to a separate database. For SQLite, use its backup API or stop writes and take a consistent snapshot including WAL; copying only a live main file is unreliable. Back up workflow state independently.

For an abruptly killed PostgreSQL Workflow worker, use the [dead-worker recovery procedure](workflow-storage.md#recover-a-job-locked-by-a-dead-worker) after confirming the old process is gone. Do not infer that a healthy replacement has resumed a job still locked by the old worker; inspect the job and its turn boundary.

For a conversation stuck at `starting`, have its authenticated owner open `/s/:operationId` and use **Cancel pending start** if they want to stop it. The endpoint also handles a budget reservation with no conversation row by installing a matching tombstone before settlement. A `200` response proves the runtime did not bind and releases the reservation at zero cost. A `409` means an active binding won or the operation cannot be cancelled; check the owned run and use its turn cancellation control. A `404` means neither an owned conversation nor an owned pending budget reservation was found; it is not evidence that a lost creation request was harmless. A `503` may follow a successful revocation with an unsettled budget: retry the same cancellation, then inspect the owner-scoped conversation, ledger reservation and model-attempt records if it persists. Do not manually write a zero-cost settlement for an active or disputed run.

For an operator-wide read-only inventory, run `npm run starts:inspect -- list` from a source checkout with the target `DATA_PROVIDER` and its backend credentials. Use `--limit N` (1–100, default 50) and pass the returned `nextCursor` through `--cursor TOKEN` until it is `null`. Rows are oldest first and include the owner, operation ID, estimate, policy, conversation status (`missing`, `starting`, `active` or `revoked`), bound session ID if present, and recorded model-attempt count. The command does not print prompts or request hashes. It performs bounded, nontransactional reads: records can change during pagination or between the budget and conversation reads. Recheck a specific operation before acting. `missing` identifies a budget-only reservation; `revoked` with no session and a remaining reservation can indicate a failed settlement. `active`, a bound revoked row, or any recorded attempt requires runtime/provider investigation before adjustment. This inventory has no mutation or refund option.

## Correct an already-settled cost

After reconciling a provider invoice or trace, use backend credentials for the target application database. PostgreSQL/Supabase must have applied `20260923173000_budget_corrections.sql`; Convex needs the updated schema/functions. The command does not use a browser token and is not exposed through REST or MCP.

```sh
npm run budgets:reconcile -- show OPERATION_UUID --tenant TENANT --subject SUBJECT
npm run budgets:reconcile -- correct OPERATION_UUID --tenant TENANT --subject SUBJECT \
  --correction-id NEW_UUID --expected unknown --actual 25000 \
  --actor OPERATOR_ID --reason 'Invoice confirms final model charge' \
  --evidence 'invoice:ticket-123'
```

`correct` prints a preview without mutating anything. Add `--apply` to the same command after checking the owner, operation, current cost, model-attempt count and evidence. Amounts are integer micro-USD; `unknown` means the current settled amount is `null`. Use an actual amount of `0` only with proof that no billable work occurred. Keep the same correction UUID and inputs when retrying after a lost response. The backend accepts the correction only if the reservation is already settled and its current amount exactly matches `--expected`; a stale correction returns `conflict` and changes nothing. It appends an immutable entry with backend time, actor, reason and evidence reference. The CLI `show` output includes the latest 100 entries; retain the database audit table and backups for full history.

This command cannot settle or refund a `reserved` operation. Investigate the runtime, attempts, binding and provider records first. A worker may still be running, so no elapsed-time rule or unverified zero is safe for outstanding starts. Provider cost envelopes, disputed-start recovery and automatic reconciliation remain release work.

Record code commit, schema version, image digest and provider for releases. Use backward-compatible expand/contract migrations so code rollback remains possible. Rotate tokens by replacing digest entries and redeploying. Record deletion does not erase model-provider history or workflow state; full account retention tooling remains pending.

Never commit `.env.local`, `.data`, `.eve`, generated `.output`, real credentials or production traces. Public template release still requires the acceptance audit in `IMPLEMENTATION.md`, dependency review and another clean-clone rehearsal of the final release revision. The original template code uses MIT; preserve [third-party notices](../THIRD_PARTY_NOTICES.md) for copied components.
