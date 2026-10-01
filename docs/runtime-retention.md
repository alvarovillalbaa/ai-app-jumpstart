# Runtime retention

The template preserves the Workflow world's default retention unless the operator builds an agent with `EVE_WORKFLOW_RETENTION=0`. The installed Eve API accepts only `default` and `0`; arbitrary durations, empty values and misspellings fail. This experimental setting is compiled into the agent artifact, alongside the selected Workflow world, without changing its model or routing. Read the installed `node_modules/eve/docs/agent-config.md` section on run retention before changing it or upgrading Eve.

Immediate purging makes finished runtime results and transcripts unavailable. The registered account chat uses those results for replay, recovery and source-event reads, so `AI_CHAT_ENABLED=true` requires default retention. The agent configuration, managed preflight and request-time chat parser enforce that constraint. Use immediate purging only for an authored flow that can tolerate disappearing runtime output and persists any required result through its own authorized service before completion.

For such a custom flow on a self-hosted Node service:

```sh
EVE_WORKFLOW_RETENTION=0 npm run build:local
WORKFLOW_EXPECTED_RETENTION=0 npm start
```

Both `EVE_WORKFLOW_RETENTION=0` and `WORKFLOW_EXPECTED_RETENTION=0` can express the runtime expectation. The production supervisor compares it with `.output/jumpstart-workflow-retention` before starting services. A default artifact cannot become a purge-on-finish artifact by setting a runtime variable, and an immediate-purge artifact refuses an unset/default runtime expectation. Artifacts predating this setting used default retention and remain compatible when no immediate purge is requested. Keep the build and runtime expectations aligned on every worker; a directly launched generated Eve worker bypasses the template supervisor. Vercel and other platform builds require matching reviewed build/runtime configuration and hosted acceptance.

`EVE_WORKFLOW_PROVIDER=postgres` composes the same native retention option with the continuously running PostgreSQL worker. The ordinary default world remains available for local Node and managed Vercel Workflow. Each separately authored agent has its own retention configuration; this setting does not globally rewrite other agents or background jobs.

| Data | Immediate native run-payload retention |
| --- | --- |
| In-progress session and turn input/state | Remains until the run reaches a terminal state |
| Finished session and turn input/output/error, step payloads, event payloads, hook metadata and stream bytes | Purged by the native world; expired metadata remains readable |
| Run IDs, status, timestamps, attributes and other operational metadata | May remain under the world's default retention |
| Auxiliary timeout, background-task and other-purpose runs | Keep their own/default policy; the timeout case is explicitly verified |
| Application records, projections, artifacts, budgets, preferences and upload metadata/bytes | Remain in their application/object stores |
| Sandbox files, telemetry, provider/connection copies and backups | Require separate retention and erasure controls |

Local Workflow marks the run expired before scrubbing related step/event/hook files and streams; expiry metadata alone is not a physical purge receipt. The rehearsal waits for actual payload removal with a bounded deadline. The native implementation can log a purge failure while allowing a run to finish. It does not provide this template with a durable retry queue or evidence that all external copies were erased. Monitor native purge failures and verify storage when handling a retention request. Immediate run-payload retention is one component of account retention; complete account export/erasure, Auth deletion, coordinated live-writer fencing, auxiliary runs, application/derived data and backup retention remain incomplete.

`npm run test:workflow-retention` compiles and runs four disposable Eve services: default and immediate retention on local storage and on real PostgreSQL Workflow storage. A gated deterministic model proves private input exists while the run is active. The default control reads the completed model response and replays its transcript after terminal reset. Immediate retention verifies native session/turn expiry and payload removal while confirming auxiliary timeout data retains its default policy. Local checks inspect step/event/hook files and empty, terminating native streams; PostgreSQL checks inspect both CBOR and legacy JSON payload columns plus stream bytes. The command uses generated fixture credentials, strips provider credentials, creates its own databases/directories, and removes its owned processes and storage. It contacts no hosted project or paid model. CI runs it in the contracts job.
