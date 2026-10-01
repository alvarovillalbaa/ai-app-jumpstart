FROM node:26-bookworm-slim@sha256:662933cf47f013bc8e4beb31a6116448427a82057ba7c42c97e4c5ba766504c2
WORKDIR /app
COPY --chown=node:node deploy/upload-scanner-gateway.mjs ./server.mjs
ENV NODE_ENV=production PORT=8081
USER node
EXPOSE 8081
CMD ["node", "server.mjs"]
