FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
WORKDIR /app
COPY --chown=node:node deploy/upload-scanner-gateway.mjs ./server.mjs
ENV NODE_ENV=production PORT=8081
USER node
EXPOSE 8081
CMD ["node", "server.mjs"]
