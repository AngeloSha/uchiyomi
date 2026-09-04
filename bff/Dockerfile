# syntax=docker/dockerfile:1.7
# ---------- deps ----------
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# sharp + @node-rs/argon2 ship prebuilt musl binaries; no build toolchain needed.
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi

# ---------- build ----------
FROM node:26-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:26-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# prune dev deps for a lean runtime image
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi
COPY --from=build /app/dist ./dist
# The API reference the server serves at /api/docs. Next to dist/, where lib/apiDocs.ts resolves it.
COPY openapi.yaml ./openapi.yaml
# postgresql-client supplies pg_dump/pg_restore for the built-in backup task (it reaches the DB over the
# network via DATABASE_URL — the container has no docker socket, so it can't shell out to the db container).
# su-exec drops privileges in the entrypoint; shadow supplies usermod/groupmod for PUID/PGID.
RUN apk add --no-cache postgresql16-client tar gzip su-exec
# Every path the app writes to must exist here and be owned by the app user. Docker seeds a NEW named
# volume from the image directory it covers, so a directory missing here becomes a root:root mountpoint
# the non-root process cannot write -- which silently costs you downloads, custom sources, and a
# persisted JWT secret (sessions then die on every restart).
RUN mkdir -p /cache /backups /config /library-dl && addgroup -g 10002 -S yomi && adduser -u 10002 -S -G yomi yomi \
 && chown -R yomi:yomi /cache /backups /config /library-dl /app
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
# `USER yomi` is gone, and that is a real trade worth naming rather than glossing.
#
# The container now STARTS as root and the entrypoint drops to uid 10002 (or PUID) via su-exec before the app
# ever runs. Previously it never ran anything as root at all. That property is given up because a process
# cannot change to the uid that owns your library without starting privileged, and the alternative was
# telling people to chown their own media collection to 10002.
#
# What is preserved: the app itself never runs as root (PUID=0 is refused, and PID 1 is the app running as
# 10002 or PUID), no capabilities are needed, and `user:` in compose still works and bypasses the root phase
# entirely for anyone who prefers that. One side effect worth knowing: `docker exec` without -u now lands as
# root rather than the app user, because the image no longer declares one.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server.js"]
