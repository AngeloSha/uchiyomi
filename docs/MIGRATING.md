# Moving from the split layout to one container

Uchiyomi used to run as two containers: `uchiyomi-bff` (the API) and `uchiyomi-web` (nginx serving the web
app). It now runs as one, `uchiyomi`, where the API serves the web app itself. The single container is the
layout the install instructions use and the one the end-to-end tests actually drive.

**You do not have to move.** The split layout still works and its images are still published. This guide is
here for when you want to, and because there was no written path before.

Moving is a compose swap, not a data migration. Both layouts use the **same named volumes** and the **same
Postgres image**, so your database, downloads, config and image cache are the same files afterwards. Nothing
is copied and nothing is converted.

---

## What actually changes

| | split | one container |
| --- | --- | --- |
| containers | `uchiyomi-bff` + `uchiyomi-web` | `uchiyomi` |
| the port inside the container | 80 (nginx) | 3000 |
| published as | `${WEB_PORT:-8080}:80` | `${WEB_PORT:-8080}:3000` |
| image size | 385 MB | 241 MB |
| deep links | `/library` redirects to `/library/` | served directly |

Everything else is identical: the same environment variables, the same volumes, the same database, the same
`PUBLIC_ORIGIN`, the same accounts and reading progress.

## The move

Run these in the directory that holds your `docker-compose.yml` and `.env`. Keeping the same directory
matters: Compose derives the project name from it, and the project name is what prefixes your volume names.

```bash
# 1. stop the old stack. This does NOT touch volumes.
docker compose down

# 2. take the new file
curl -O https://raw.githubusercontent.com/AngeloSha/uchiyomi/main/deploy/docker-compose.yml

# 3. start it
docker compose pull
docker compose up -d
```

Open the app on the same port as before. You will not be logged out and nothing needs re-scanning.

> **If you keep both files around**, pass the one you mean with `-f`, for example
> `docker compose -f docker-compose.split.yml up -d`. What you must not do is run the two files as two
> different projects in two different directories: that gives you a second, empty set of volumes, and it
> will look like your library vanished.

## If you use a reverse proxy

This is the one step that is easy to forget, because nothing errors: your proxy is pointed at
**`uchiyomi-web` port 80**, and that container no longer exists. Repoint it at **`uchiyomi` port 3000**.

If you attach the app to your proxy's network with an override file, the service name changes too:

```yaml
# docker-compose.override.yml
networks:
  proxy:
    external: true
services:
  uchiyomi:                            # was: uchiyomi-web
    networks: [uchiyomi_app, uchiyomi_internal, proxy]
```

While you are there: the compose file publishes a host port so a fresh install works out of the box, but if
your proxy reaches the container over a Docker network you do not need that port at all. Deleting the
`ports:` entry stops the app being served over plain HTTP alongside your HTTPS domain.

## If you monitor `/healthz`

`/healthz` used to be answered by nginx with a static `ok`, without touching the API. It is now the
application's own readiness probe: it queries the database and returns **503** when the database is
unreachable. That is more useful, but it is a different thing to what you were measuring.

If you want a plain "is the process alive" check, use **`/livez`**, which answers unconditionally. The
container's own healthcheck uses `/livez` for exactly this reason.

## Rolling back

Nothing about the move is one-way, because nothing about your data changed:

```bash
docker compose down
curl -O https://raw.githubusercontent.com/AngeloSha/uchiyomi/main/deploy/docker-compose.split.yml
docker compose -f docker-compose.split.yml up -d
```

Then point your reverse proxy back at `uchiyomi-web:80`.

## CasaOS

The CasaOS manifest at [`deploy/casaos/docker-compose.yml`](../deploy/casaos/docker-compose.yml) ships the
single container. If you installed an older split-layout manifest, remove the app from CasaOS and re-import
this one — CasaOS keeps the volumes, so your library survives.
