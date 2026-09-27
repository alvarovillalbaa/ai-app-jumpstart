#!/bin/sh
set -eu
case "${ORIGIN_GUARD:-}" in
  ''|*[!0-9a-f]*) echo 'ORIGIN_GUARD must contain 64 lowercase random hex characters.' >&2; exit 1 ;;
esac
if [ "${#ORIGIN_GUARD}" -ne 64 ]; then
  echo 'ORIGIN_GUARD must contain 64 lowercase random hex characters.' >&2; exit 1
fi
: "${EVE_UPSTREAM:?Set the private Eve upstream.}"
: "${NEXT_UPSTREAM:?Set the private readiness upstream.}"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
