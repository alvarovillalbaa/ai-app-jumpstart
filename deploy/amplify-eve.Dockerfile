FROM caddy@sha256:504a44d7d74bd2bc28a66afc4774912fc21223ca8a67734af1c54ab2f999b489
COPY --chown=1000:1000 deploy/amplify-eve.Caddyfile /etc/caddy/Caddyfile
COPY --chmod=755 deploy/amplify-eve-entrypoint.sh /usr/local/bin/jumpstart-ingress
RUN mkdir -p /config /data && chown -R 1000:1000 /config /data
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/jumpstart-ingress"]
