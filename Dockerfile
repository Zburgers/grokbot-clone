# syntax=docker/dockerfile:1
#
# hivebot — HiveMind Grid image for the grokbot-clone fork.
#
# Two images come out of this repository. This one is the Hono server that also
# serves the built React app (single process, port 8787). The second is
# `hivebot-desktop`, built unchanged from ./desktop/Dockerfile.
#
# The app never talks to the Docker socket. Everything it does on a "computer"
# (screenshots, clicks, shell, files) is an HTTP/WebSocket call to the desktop
# daemon, which is a separate, unrouted container holding no application
# credentials. See deploy/grid/README.md.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 ships prebuilt binaries for Node 22 on linux/amd64, but falls
# back to a source build when none matches the target ABI. Keeping the toolchain
# in the builder means that fallback cannot fail the release, while the runtime
# image stays slim.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY server ./server
COPY web ./web
# `npm run build` = web (vite) then server (tsc). Output: web/dist + server/dist.
RUN npm run build

FROM deps AS prod-deps
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim AS runtime
# HOST must be 0.0.0.0 inside a container: the upstream default of 127.0.0.1 is
# for a host process fronted by Tailscale Serve and would be unreachable from a
# peer container. Exposure is controlled by the compose port binding, which is
# the Tailscale address only — never 0.0.0.0 on the public interface.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DB_PATH=/data/grokbot.db
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
# Operator utility: generate OWNER_PASSWORD_HASH (run it here or on a workstation,
# never on a host that stores the plaintext).
COPY scripts ./scripts
# SQLite (WAL) lives on the volume; the image itself stays read-only-able.
RUN mkdir -p /data && chown -R node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# No --env-file: environment comes from the compose env_file. The server resolves
# web/dist relative to its own dist directory, so /app/server/dist + /app/web/dist
# and WORKDIR=/app must stay together.
CMD ["node", "server/dist/index.js"]
