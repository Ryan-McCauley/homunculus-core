# Homunculus backend — serves the web UI and the WebSocket API.
# The Electron desktop shell is NOT part of this image; it connects as a client.
FROM node:20-bookworm-slim

WORKDIR /app

# Toolchain for node-pty's native build fallback (prebuilds are used when available).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Don't pull the Electron binary into the server image — it's a dev-only dependency here.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:web

ENV HOMUNCULUS_HOST=0.0.0.0 \
    HOMUNCULUS_PORT=8787 \
    HOMUNCULUS_WEB_DIR=/app/out/renderer \
    NODE_ENV=production

EXPOSE 8787

# Provide CLAUDE_CODE_OAUTH_TOKEN and HOMUNCULUS_TOKEN at runtime (env or compose).
CMD ["npx", "tsx", "server/index.ts"]
