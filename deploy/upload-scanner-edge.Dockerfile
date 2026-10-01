FROM caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
COPY --chown=1000:1000 deploy/upload-scanner.Caddyfile /etc/caddy/Caddyfile
RUN setcap -r /usr/bin/caddy && mkdir -p /config /data && chown -R 1000:1000 /config /data
USER 1000:1000
