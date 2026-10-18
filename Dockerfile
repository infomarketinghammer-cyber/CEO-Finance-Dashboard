# syntax=docker/dockerfile:1
#
# DHYEYA — single image: the API and the built client on one port.
#   docker build -t dhyeya .
#   docker run -p 4000:4000 -v dhyeya-data:/data \
#     -e JWT_SECRET=... -e BOOTSTRAP_ADMIN_PASSWORD=... dhyeya

ARG NODE_VERSION=22

# ---- client build -------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS client-build
WORKDIR /build/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---- server build + production dependencies -----------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS server-build
# Toolchain only as a fallback when no prebuilt better-sqlite3 binary matches.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build
RUN npm prune --omit=dev

# ---- runtime ------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    SQLITE_FILE=/data/dhyeya.sqlite \
    UPLOAD_DIR=/data/uploads
WORKDIR /app/server

COPY --from=server-build /build/server/node_modules ./node_modules
COPY --from=server-build /build/server/dist ./dist
COPY --from=server-build /build/server/package.json ./package.json
COPY server/assets ./assets
# The server serves ../client/dist relative to the server root.
COPY --from=client-build /build/client/dist /app/client/dist

# Database and uploaded workbooks live on a volume, never inside the image.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>r.json()).then(j=>process.exit(j.status==='ok'?0:1)).catch(()=>process.exit(1))"

# Migrate (idempotent), seed (idempotent: creates categories and the first admin
# only if absent), then start. exec keeps node as PID 1 so SIGTERM drains cleanly.
CMD ["sh", "-c", "node dist/db/cli.js migrate && node dist/db/cli.js seed && exec node dist/index.js"]
