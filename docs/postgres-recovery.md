# Stopped PostgreSQL database set

Use this procedure when a self-hosted deployment keeps application data in PostgreSQL and Eve execution in a **different PostgreSQL database**. It makes one private, verifiable directory containing both database archives. It does not collect private upload objects, cluster roles, Auth-provider data outside the application database, or a managed Vercel Workflow world.

Stop every application instance, Eve instance and Workflow worker for this environment, and prevent schedulers or replacement instances from restarting them. Let active turns settle or record them for review. Resolve any locked Graphile jobs before proceeding. `--stopped` records the operator's assertion; the command cannot discover a writer on another host or guarantee that a prior external model/tool side effect settled.

Export the intended private `DATABASE_URL` and `WORKFLOW_POSTGRES_URL` in the operator shell. This command does not load `.env.local`, and it never puts either URL in process arguments or its manifest. Use `pg_dump` and `pg_restore` from a PostgreSQL client release at least as new as the source server's major version. Choose a new path under a private backup directory, then run:

```sh
npm run backup:postgres-databases -- --create \
  --output /PRIVATE_BACKUPS/database-set-YYYYMMDD --stopped
npm run backup:postgres-databases -- --verify \
  /PRIVATE_BACKUPS/database-set-YYYYMMDD
```

For a stronger rehearsal, create two **different, empty, loopback** PostgreSQL databases and export their private URLs as `BACKUP_VERIFY_APP_DATABASE_URL` and `BACKUP_VERIFY_WORKFLOW_DATABASE_URL`. Add `--verify-restore` to the create command. It restores each archive in one transaction, compares the application migration ledger and Workflow/Graphile migration, run and event counts, and marks the manifest `restoreVerified: true` only after both restores pass. These disposable target databases remain populated for operator inspection; drop them after the rehearsal. If either restore fails, inspect and drop both disposable targets before retrying, even though the incomplete output directory is removed.

The command refuses the same source database for both roles, an existing destination, a missing stopped acknowledgement, or just one restore target. It creates the directory mode 0700, writes `application.dump` and `workflow.dump` mode 0600, then publishes `manifest.json` last with SHA-256 and size for each archive. A normal failure removes the directory it created. A process crash can leave an incomplete directory: `--verify` rejects missing, extra or altered files. Re-run `--verify` after transferring a set and before recovery. The manifest detects accidental changes but is not signed and cannot authenticate an untrusted backup.

These are **two sequential database snapshots**, not one distributed transaction. The stopped maintenance window is what prevents application/Workflow writes between them. If local upload storage is enabled, snapshot its private object root in the same window and track that copy with the database set. For Supabase Storage or another external object provider, use that provider's separate backup and restore procedure. Retain the matching application image digest, secrets, migration list and deployment settings in the release record.

For recovery, verify the set, restore each archive into a fresh database with the intended roles and grants, and point a disposable application/Eve deployment at both restored databases. Rehearse owner-isolated REST/CLI/MCP reads, a previously completed conversation, an owned follow-up, Workflow callbacks and any private object references before switching traffic. The optional loopback restore uses `--no-owner --no-acl`; production roles and policies need separate review. Never overwrite an existing production database as a shortcut. The local tests verify the paired archive/manifest and both database restores; the separate Eve runtime suite proves completed-session replay from a restored Workflow database. A combined hosted restore and a credentialed model turn remain release acceptance work.
