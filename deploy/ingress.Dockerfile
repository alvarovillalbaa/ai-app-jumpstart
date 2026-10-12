FROM caddy@sha256:f2a1290d0463aad60660d4ec134943f183ee2a5f6c3eb7bf32dd984f2f020772

COPY --chown=1000:1000 deploy/split-app.Caddyfile /etc/caddy/Caddyfile
COPY --chown=1000:1000 deploy/split-app-routes.Caddyfile /etc/caddy/split-app-routes.Caddyfile
RUN mkdir -p /config /data && chown -R 1000:1000 /config /data
USER 1000:1000
