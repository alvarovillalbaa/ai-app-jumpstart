FROM caddy@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b

COPY --chown=1000:1000 deploy/split-app.Caddyfile /etc/caddy/Caddyfile
COPY --chown=1000:1000 deploy/split-app-routes.Caddyfile /etc/caddy/split-app-routes.Caddyfile
RUN mkdir -p /config /data && chown -R 1000:1000 /config /data
USER 1000:1000
