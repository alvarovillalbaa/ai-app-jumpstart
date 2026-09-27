FROM caddy@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d
COPY --chown=1000:1000 deploy/amplify-eve.Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 deploy/amplify-eve-entrypoint.sh /usr/local/bin/jumpstart-ingress
RUN mkdir -p /config /data && chown -R 1000:1000 /config /data
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/jumpstart-ingress"]
