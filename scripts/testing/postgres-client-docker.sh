#!/usr/bin/env sh
set -eu

# The CI provider harness uses an embedded PostgreSQL 18 server on loopback.
# Run matching client binaries without installing them on the runner host.
tool="${1:-}"
case "$tool" in pg_dump|pg_restore) shift ;; *) exit 2 ;; esac
exec docker run --rm --network host --user "$(id -u):$(id -g)" \
  --volume /tmp:/tmp \
  --env PGHOST --env PGPORT --env PGUSER --env PGPASSWORD --env PGDATABASE \
  --env PGSSLMODE --env PGSSLROOTCERT --env PGSSLCERT --env PGSSLKEY \
  --env PGCONNECT_TIMEOUT --env PGAPPNAME --env PGTARGETSESSIONATTRS \
  --env PGOPTIONS --env PGCHANNELBINDING --env PGGSSENCMODE \
  postgres:18-bookworm "$tool" "$@"
