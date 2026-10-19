FROM caddy@sha256:685ae3d7c34d9b5f8caeddc5d14051db7bbd88ff1f5a2fa0c16bd8ca328fb7af
COPY --chown=1000:1000 deploy/amplify-eve.Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 deploy/amplify-eve-entrypoint.sh /usr/local/bin/jumpstart-ingress
RUN mkdir -p /config /data && chown -R 1000:1000 /config /data
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/jumpstart-ingress"]
