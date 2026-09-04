# Moving between layouts

Uchiyomi runs in one of three shapes, all on the same image and the same volumes:

| | containers | the database |
| --- | --- | --- |
| **one container** (`deploy/docker-compose.yml`, the default since v0.18.0) | `uchiyomi` | inside the container, on a unix socket, in the `uchiyomi_data` volume |
| external database (`deploy/docker-compose.external-db.yml`) | `uchiyomi` + `uchiyomi-db` | a Postgres container you run |
| split (`deploy/docker-compose.split.yml`) | `uchiyomi-bff` + `uchiyomi-web` + `uchiyomi-db` | a Postgres container you run |

**You do not have to move.** Every layout keeps working and every image keeps being published. The one
thing that decides which database is used is `DATABASE_URL`: set, the container talks to it; unset, the
container starts a Postgres of its own. An existing install never drifts into the embedded one by accident.

- [One container, no database container](#one-container-no-database-container)
- [External database → one container](#external-database--one-container)
- [One container → external database](#one-container--external-database)
- [Upgrading the embedded Postgres major](#postgres-upgrade)
- [From the split layout to one container](#moving-from-the-split-layout-to-one-container)

## One container, no database container

Leave `DATABASE_URL` unset and the entrypoint runs Postgres 16 inside the container: data in `/data/pg` (the
`uchiyomi_data` volume), a unix socket only -- there is no network listener, so nothing outside the
container can reach it and there is no password to manage -- and the app pointed at it before it starts.
Postgres logs into the container log alongside the app's. On `docker stop` the app finishes what it is
writing and then Postgres stops cleanly; the compose file sets `stop_grace_period: 40s` for that, because
Docker's default ten seconds would kill a checkpoint. If Postgres ever dies underneath the app, the container
exits and `restart: unless-stopped` brings both halves back in order.

Everything else is identical: the same environment, the same `/config`, `/cache`, `/library-dl` and
`/backups`, the same nightly backup task -- it dumps the embedded database exactly as it dumped an external
one, into `/backups`. Back up the `uchiyomi_data` volume like any other, or rely on that dump.

`PUID`/`PGID` apply to the database too: it runs as the same uid as the app, and the entrypoint takes
ownership of `/data` the way it does the other app-owned volumes. Postgres insists that the uid it runs as
has a passwd entry, and the owner of your library normally has none inside the image, so the entrypoint adds
one. A container started with `user:` instead cannot be given an entry, so the lookup is answered through
`nss_wrapper` the way the official Postgres image does it; such a container must also be given a `/data` it
can write.

## External database → one container

A dump and a restore. The nightly backup is already the right format (plain SQL, gzipped), so if last
night's is recent enough you can skip the first step and use it.

```bash
# 1. dump, while the old stack is still up (or take the newest file from your /backups volume)
docker compose -f docker-compose.external-db.yml exec uchiyomi-db \
  pg_dump -U yomi --no-owner --no-acl --clean --if-exists yomi | gzip > uchiyomi.sql.gz

# 2. stop the old stack. This does NOT touch volumes.
docker compose -f docker-compose.external-db.yml down

# 3. take the one-container file and start it once, so the embedded database is initialised
curl -O https://raw.githubusercontent.com/AngeloSha/uchiyomi/main/deploy/docker-compose.yml
docker compose up -d
docker compose logs uchiyomi | grep -m1 'embedded Postgres'     # "starting embedded Postgres 16"

# 4. restore into it, over the socket, then restart so the app sees your data
gunzip -c uchiyomi.sql.gz | docker compose exec -T uchiyomi \
  psql -q "postgres://yomi@/yomi?host=/run/postgresql"
docker compose restart uchiyomi
```

Open the app: same accounts, same progress, same library. The old `uchiyomi_pgdata` volume is untouched;
delete it once you are happy (`docker volume rm <project>_uchiyomi_pgdata`).

## One container → external database

The reverse: dump over the socket, start the external layout, restore into its database.

```bash
docker compose exec -T uchiyomi pg_dump --no-owner --no-acl --clean --if-exists \
  "postgres://yomi@/yomi?host=/run/postgresql" | gzip > uchiyomi.sql.gz
docker compose down
curl -O https://raw.githubusercontent.com/AngeloSha/uchiyomi/main/deploy/docker-compose.external-db.yml
docker compose -f docker-compose.external-db.yml up -d uchiyomi-db
gunzip -c uchiyomi.sql.gz | docker compose -f docker-compose.external-db.yml exec -T uchiyomi-db psql -q -U yomi yomi
docker compose -f docker-compose.external-db.yml up -d
```

## Postgres upgrade

The image pins one Postgres major (16 today). A data directory written by a different major cannot be
opened by it, and rather than crash-loop on Postgres's own error the entrypoint refuses to start and prints:

```
the database in /data/pg is Postgres 16 and this image ships Postgres 17.
  It needs upgrading before it can be opened: see docs/MIGRATING.md#postgres-upgrade.
```

When Uchiyomi moves to a new major, the release notes will say so, and that release will ship as a
transition image carrying both majors that runs `pg_upgrade` on first boot. Until then, the upgrade path is
the dump-and-restore above: dump with the old image, start the new one on an empty `uchiyomi_data` volume,
restore. Nothing about your data is lost either way; the guard exists so that nothing is lost by surprise.

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
