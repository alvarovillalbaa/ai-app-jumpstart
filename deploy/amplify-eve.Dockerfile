FROM caddy@sha256:0c994536bddb66445885237f1a5dcc1916bccea922661c76b4e9fc24061f9b52
COPY --chown=1000:1000 deploy/amplify-eve.Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 deploy/amplify-eve-entrypoint.sh /usr/local/bin/jumpstart-ingress
RUN mkdir -p /config /data && chown -R 1000:1000 /config /data
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/jumpstart-ingress"]
