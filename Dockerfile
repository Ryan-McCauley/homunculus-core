# Homunculus backend — serves the web UI and the WebSocket API.
# The Electron desktop shell is NOT part of this image; it connects as a client.
#
# Two stages. The builder needs the full dev toolchain (vite, react, typescript) to
# produce out/renderer, none of which the running server has any use for — shipping
# them meant a much larger image and a much larger patch surface for a process that
# holds exchange credentials. The runtime stage keeps the built renderer, the server
# sources, and production dependencies only.

# ── Stage 1: build the web UI ────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build

WORKDIR /app

# Toolchain for node-pty's native build fallback (prebuilds are used when available).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Don't pull the Electron binary into the image — it's a dev-only dependency here.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build:web
# Strip devDependencies in place, keeping the already-compiled node-pty binary. tsx
# is a production dependency precisely because the CMD below runs the TypeScript
# server through it.
RUN npm prune --omit=dev

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    HOMUNCULUS_HOST=0.0.0.0 \
    HOMUNCULUS_PORT=8787 \
    HOMUNCULUS_WEB_DIR=/app/out/renderer \
    NODE_ENV=production

# Only what the server actually needs at runtime.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/out ./out
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/server ./server
COPY --from=build --chown=node:node /app/shared ./shared
COPY --from=build --chown=node:node /app/engine ./engine
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json

# data/ is a mounted volume at runtime; create it owned by the unprivileged user so
# the server can write there without running as root.
RUN mkdir -p /app/data /app/private && chown -R node:node /app/data /app/private

# The terminal channel hands out a shell inside this container. Root is not the user
# that shell should be, and an RCE anywhere in the server should not land as root
# either. node:20 ships an unprivileged `node` user for exactly this.
USER node

EXPOSE 8787

# restart:unless-stopped only rescues a CRASHED process. This catches a wedged one —
# which matters because the take-profit/stop monitor lives in this process and a
# hung server keeps resting orders on the exchange with nothing watching them.
# Uses node's own fetch rather than curl/wget, which the slim image does not ship.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HOMUNCULUS_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Provide CLAUDE_CODE_OAUTH_TOKEN and HOMUNCULUS_TOKEN at runtime (env or compose).
CMD ["npx", "tsx", "server/index.ts"]
