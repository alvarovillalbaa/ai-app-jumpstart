FROM caddy@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52
COPY --chown=1000:1000 deploy/upload-scanner.Caddyfile /etc/caddy/Caddyfile
RUN setcap -r /usr/bin/caddy && mkdir -p /config /data && chown -R 1000:1000 /config /data
USER 1000:1000
