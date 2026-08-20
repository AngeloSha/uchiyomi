# syntax=docker/dockerfile:1.7
# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# sharp + @node-rs/argon2 ship prebuilt musl binaries; no build toolchain needed.
RUN if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; \
    else npm install --no-audit --no-fund; fi

# ---------- build ----------
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# prune dev deps for a lean runtime image
COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; \
    else npm install --omit=dev --no-audit --no-fund; fi
COPY --from=build /app/dist ./dist
# postgresql-client supplies pg_dump/pg_restore for the built-in backup task (it reaches the DB over the
# network via DATABASE_URL — the container has no docker socket, so it can't shell out to the db container).
RUN apk add --no-cache postgresql16-client tar gzip
# Every path the app writes to must exist here and be owned by the app user. Docker seeds a NEW named
# volume from the image directory it covers, so a directory missing here becomes a root:root mountpoint
# the non-root process cannot write -- which silently costs you downloads, custom sources, and a
# persisted JWT secret (sessions then die on every restart).
RUN mkdir -p /cache /backups /config /library-dl && addgroup -g 10002 -S yomi && adduser -u 10002 -S -G yomi yomi \
 && chown -R yomi:yomi /cache /backups /config /library-dl /app
USER yomi
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz >/dev/null 2>&1 || exit 1
CMD ["node", "dist/server.js"]
