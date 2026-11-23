FROM caddy@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b
COPY --chown=1000:1000 deploy/upload-scanner.Caddyfile /etc/caddy/Caddyfile
RUN setcap -r /usr/bin/caddy && mkdir -p /config /data && chown -R 1000:1000 /config /data
USER 1000:1000
