# Public self-hosted HTTPS

The base Compose stack binds only `127.0.0.1:3000`. For a single public host, add the streaming and HTTPS overlays so Caddy is the only published service. The public ingress shares the tested direct Eve/Workflow routes with the internal cloud proxy, serves Next through the same origin, redirects HTTP to HTTPS and persists its certificate state in separate volumes. The app's `APP_ORIGIN` is set from `APP_DOMAIN` by the overlay, so the browser and server use the same HTTPS origin.

Use one DNS name such as `app.example.com` as `APP_DOMAIN`; do not include `https://`, a port, path or wildcard. Point its public A/AAAA records at the host, allow inbound TCP 80 and 443, and make sure neither port is used by another proxy. Caddy needs both ports and a persistent writable `/data` volume to obtain and renew public certificates ([Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)). Keep the production `.env.local` private and configure the application, Auth redirect URLs, model credentials and chosen data/Workflow stores before starting. For a single-host SQLite/local Workflow setup, retain the `app-data` and `eve-data` volumes; for PostgreSQL, include the reviewed database overlays and migrations. See [hosting](hosting.md) and [recovery](local-recovery.md).

```sh
export APP_DOMAIN=app.example.com
docker compose -f compose.yaml -f compose.streaming.yaml \
  -f compose.public-https.yaml config --no-env-resolution --quiet
docker compose -f compose.yaml -f compose.streaming.yaml \
  -f compose.public-https.yaml up --build -d
```

Use `docker-compose` if that is the installed Compose command. Put `compose.postgres.yaml` and any reviewed Workflow overlay between `compose.yaml` and the two ingress overlays when using those stores. `compose.public-https.yaml` must be last so it replaces the loopback ingress port and config mount. The app and Eve ports remain private; only Caddy publishes host ports 80 and 443. `APP_ORIGIN=https://$APP_DOMAIN` in the Compose service overrides any stale value in `.env.local`. The Caddy config sends HSTS on successful HTTPS responses, without applying it to the HTTP redirect. Review the domain before opening the service: after a browser records HSTS, a broken certificate prevents ordinary browser access until TLS is repaired.

Verify the deployed origin and real behavior before accepting traffic:

```sh
curl -I http://app.example.com/records
curl -I https://app.example.com/api/health/live
curl -I https://app.example.com/api/health/ready
curl -I https://app.example.com/eve/v1/health
```

The first response should redirect to HTTPS. Require a publicly trusted certificate, combined app/data/Eve readiness, and the actual signed-in two-owner and owned-turn [post-deployment smoke](hosting.md#post-deployment-data-smoke). Check separate SSE chunks through the public origin, Workflow callbacks, login/logout redirects, instance replacement and backups. A healthy proxy or HTTPS handshake alone does not prove those behaviors. If uploads are enabled, schedule and monitor [quarantine cleanup](uploads.md); local private objects need a persistent private volume and a coordinated backup. Keep `caddy-data` and `caddy-config` across upgrades; `docker compose down -v` removes them and is not a routine stop command. Back up certificate private keys securely and monitor renewal errors and expiry.

Run `npm run test:public-ingress` before customizing the proxy. It uses disposable mock Next/Eve containers and Caddy's local test CA to verify trusted HTTPS, redirect, host isolation, both routes, live SSE and certificate persistence after ingress replacement. It does not obtain a public ACME certificate or prove DNS, firewall, production Auth, database or model behavior.
