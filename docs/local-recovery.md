# Offline self-hosted snapshot and restore

Use this procedure only for a **single-host, default-world** deployment with a SQLite application database and Eve's local Workflow store. The application database, Eve run history and optional local upload objects are separate data stores. A snapshot must contain all three when local uploads are enabled. PostgreSQL/managed application data, PostgreSQL Workflow, Supabase Storage and Vercel Workflow need their own provider backups; this command does not copy them.

Stop the application and Eve processes, block other writers to these paths, and let active turns finish or record them for review. `--stopped` is an operator assertion; the command cannot detect a process on another host or prove that an in-flight model/tool side effect has settled. Choose a fresh destination in a private directory outside the checkout. Use the deployment's actual `SQLITE_PATH`, Eve `.eve/.workflow-data` path and, when `UPLOAD_STORAGE_PROVIDER=local`, its `UPLOAD_LOCAL_ROOT`:

```sh
npm run backup:local -- --create \
  --app-db .data/app.sqlite \
  --workflow-dir .eve/.workflow-data \
  --uploads-dir /PRIVATE_UPLOAD_ROOT \
  --output /PRIVATE_BACKUPS/snapshot-YYYYMMDD --stopped
npm run backup:local -- --verify /PRIVATE_BACKUPS/snapshot-YYYYMMDD
```

Use `--no-uploads` **only** when local upload storage is disabled. When runtime provider/path environment variables are present, the command checks them against the selected sources; it also rejects a built PostgreSQL Workflow world. It refuses a missing or uninitialized application database, symlinks and special files in the copied trees, overlapping source/destination paths and an existing output directory. It uses SQLite's online backup API for the application database, then copies the stopped Workflow/upload trees with private file modes. `manifest.json` is written last and contains each file's SHA-256 and size. Its hashes detect accidental or unaccompanied file changes; the manifest is not signed and does not authenticate an untrusted backup. A failed command removes its own incomplete output; after a process crash, treat a directory without a valid manifest as incomplete and do not restore it. Keep the snapshot private, encrypted as required, and subject to a retention policy.

For a **restore rehearsal**, verify the snapshot and copy it into a new empty directory. The command verifies the restored copy again and refuses to overwrite any destination:

```sh
npm run backup:local -- --restore /PRIVATE_BACKUPS/snapshot-YYYYMMDD \
  --output /PRIVATE_RESTORE_TEST/jumpstart
npm run backup:local -- --verify /PRIVATE_RESTORE_TEST/jumpstart
```

With the app stopped, map `app.sqlite` to the configured `SQLITE_PATH`, `workflow/` to the app root's `.eve/.workflow-data`, and `uploads/` to `UPLOAD_LOCAL_ROOT` only when the manifest says uploads were included. Eve's default local world selects that path from the running app root; setting `WORKFLOW_LOCAL_DATA_DIR` alone does not move it. Use fresh empty mounts/directories; do not mix the restored database with old `-wal` or `-shm` files. Restore the corresponding application build and private environment separately. Start the restored instance against a disposable origin and verify web/data/Eve readiness, owner-isolated REST/CLI/MCP reads, a previously completed conversation and a new owned turn before relying on it. `npm run test:session-runtime` creates a real completed Eve session, snapshots its SQLite application data and local Workflow files after shutdown, restores them into a fresh app root, replays the same session without another model call, denies a foreign owner and completes a new owned turn. Focused tests also cover SQLite WAL capture, private-upload copying, tampering and no-clobber behavior. `npm run test:container` now writes the stopped snapshot to a separate Docker volume, verifies and restores it, then boots the production image with fresh application and Eve volumes; the original record and owner-isolated REST/CLI/MCP path survive. That image test does not restore a chat session. A live production backup still needs transaction coordination across stores and deployment-specific recovery acceptance.

For the supplied Docker Compose service, stop `app` first and ensure its status is stopped. The production image contains this Node-only command and a node-owned `/app/.backup` mountpoint. Mount a **separate** private host directory writable by the image's `node` user for the output; keeping the only snapshot on `app-data` would lose it with that volume:

```sh
docker compose stop app
docker compose run --rm --no-deps --volume /HOST_PRIVATE_BACKUPS:/app/.backup app \
  node scripts/backup-local.mjs --create \
  --app-db /app/.data/app.sqlite \
  --workflow-dir /app/.eve/.workflow-data \
  --no-uploads --output /app/.backup/snapshot-YYYYMMDD --stopped
docker compose start app
```

Replace `--no-uploads` with `--uploads-dir /MOUNTED_UPLOAD_ROOT` when local uploads are enabled and mounted into the Compose service. A Compose one-off run inherits the service's volumes and does not publish its ports; `--no-deps` prevents it from starting linked services. Keep the application stopped until the command finishes. If the snapshot fails, investigate before restarting or using an incomplete backup. This procedure is for the default local Workflow world; the cloud PostgreSQL-world recipes require coordinated provider snapshots instead.
