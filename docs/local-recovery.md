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

With the app stopped, map `app.sqlite` to the configured `SQLITE_PATH`, `workflow/` to `.eve/.workflow-data`, and `uploads/` to `UPLOAD_LOCAL_ROOT` only when the manifest says uploads were included. Use fresh empty mounts/directories; do not mix the restored database with old `-wal` or `-shm` files. Restore the corresponding application build and private environment separately. Start the restored instance against a disposable origin and verify web/data/Eve readiness, owner-isolated REST/CLI/MCP reads, a previously completed conversation and a new owned turn before relying on it. Focused tests prove file-level snapshot integrity, SQLite WAL capture and restore, and private upload/Workflow file copying. The production container contract also creates and verifies a stopped snapshot from persistent app/Eve volumes. These checks do not yet prove that a restored real Eve session resumes or that a live production backup is transactionally coordinated across stores.

For the supplied Docker Compose service, stop `app` first and ensure its status is stopped. The production image contains this Node-only command. Mount a private host directory writable by the image's `node` user for the output:

```sh
docker compose stop app
docker compose run --rm --no-deps --volume /HOST_PRIVATE_BACKUPS:/backup app \
  node scripts/backup-local.mjs --create \
  --app-db /app/.data/app.sqlite \
  --workflow-dir /app/.eve/.workflow-data \
  --no-uploads --output /backup/snapshot-YYYYMMDD --stopped
docker compose start app
```

Replace `--no-uploads` with `--uploads-dir /MOUNTED_UPLOAD_ROOT` when local uploads are enabled and mounted into the Compose service. A Compose one-off run inherits the service's volumes and does not publish its ports; `--no-deps` prevents it from starting linked services. Keep the application stopped until the command finishes. If the snapshot fails, investigate before restarting or using an incomplete backup. This procedure is for the default local Workflow world; the cloud PostgreSQL-world recipes require coordinated provider snapshots instead.
