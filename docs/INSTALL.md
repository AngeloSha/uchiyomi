# Installing Uchiyomi

The two-command quick start lives in the [README](../README.md). This page is everything else: the one-click
app stores, what each container is for, keeping it up to date, and putting it behind a domain.

## Other layouts

<details>
<summary>Prefer to run Postgres yourself?</summary>

Set `DATABASE_URL` and the same image talks to your database instead of starting its own; that one variable
is the whole switch. [`deploy/docker-compose.external-db.yml`](../deploy/docker-compose.external-db.yml) is
that layout ready to use, with a Postgres container beside the app -- it is what the install instructions
used before v0.18.0, and an existing install keeps working on it unchanged. Moving between the two is a
dump and a restore, written down in both directions in **[docs/MIGRATING.md](MIGRATING.md)**.
</details>

<details>
<summary>Already running the older two-container layout?</summary>

Uchiyomi used to ship as `uchiyomi-bff` + `uchiyomi-web`, with a separate nginx serving the web app. That
layout is **deprecated but not dead**: it is still built, still published and still works, and nothing about
your install has stopped functioning. You are not required to move.

It is deprecated because the single container measured better on the same host — **265 MB instead of
441 MB**, less memory, one less network hop on every API call, and no redirect on deep links — and because
the end-to-end tests only ever drive the single container, so it is the layout that is actually proven on
every commit.

Moving to the external-database layout is a compose swap, not a data migration: both use the **same named
volumes** and the same Postgres image. Four commands, in **[docs/MIGRATING.md](MIGRATING.md)**. The
file itself is still there as [`deploy/docker-compose.split.yml`](../deploy/docker-compose.split.yml).
</details>

## File ownership

To read a library you already have, point `LIBRARY_PATH` at it. By default Uchiyomi runs as its own user and
**cannot write to your files at all**; set `PUID`/`PGID` to your own ids (`id -u`, `id -g`) if you want it to
be able to rename folders and delete chapters:

```bash
echo "LIBRARY_PATH=/path/to/your/manga" > .env
docker compose up -d
```

## One-click installs

**On CasaOS?** Use [`deploy/casaos/docker-compose.yml`](../deploy/casaos/docker-compose.yml) instead — import it
as a custom app and it appears with an icon like any store app. That manifest leaves out the extension
engine, so Mihon/Tachiyomi extensions are off there; add `uchiyomi-suwayomi` from
[`deploy/docker-compose.yml`](../deploy/docker-compose.yml) and set `SUWAYOMI_URL` if you want them.

**On Unraid?** The template is [`templates/uchiyomi.xml`](../templates/uchiyomi.xml) in this repository,
which is laid out as a Community Applications template repository (`templates/` plus the `ca_profile.xml`
at the root) and is being submitted to Community Applications. Once it is listed there, install it from the
**Apps** tab like anything else. Until it shows up, copy the file to
`/boot/config/plugins/dockerMan/templates-user/` on the server, then *Docker → Add Container* and pick
*uchiyomi* under **User templates**, as before. One container, database included; set PUID/PGID to the
owner of your library for renames.

Unraid removed the *Template repositories* field in 6.10, and since 7.3 the file behind it is not read at
all, so pointing Unraid at a template repository URL no longer works on any current version — the template
file itself has to be on the server, or come through Community Applications. The
[`unraid-templates`](https://github.com/AngeloSha/unraid-templates) repository is kept only so old links
keep working; it points here.

**On Umbrel?** Uchiyomi is [submitted to the Umbrel App Store](https://github.com/getumbrel/umbrel-apps/pull/6055); until it is listed, the package at
[`deploy/umbrel/uchiyomi`](../deploy/umbrel/uchiyomi) is the exact one under review. It runs the database inside
the container, reads your library from *Downloads/manga*, and includes the Cloudflare solver; the Mihon
extension engine is not part of it.

## What each container is for

| Container | Role |
|---|---|
| `uchiyomi` | the app: the API, the PWA it serves, and the embedded Postgres database |
| `uchiyomi-flaresolverr` | Cloudflare solver — **started automatically**; sources that need it use it with no config |
| `uchiyomi-suwayomi` | the extension engine, so Mihon / Tachiyomi extensions work ([docs](extensions.md)) |

```bash
docker compose logs -f uchiyomi  # watch it boot
```

Cloning the repo and want a CLI-seeded admin instead of the browser setup step? `bash scripts/setup.sh`
generates the secrets, creates the admin from a password you type, fixes volume ownership, and starts the
development stack — which builds the **same single container** the install ships, so what you run matches
what you would have deployed. It refuses to run in a checkout whose `docker-compose.override.yml` manages a
service it does not, so it cannot restart a server install.

Change the port with `WEB_PORT` in `.env` (default `8080`; e.g. `WEB_PORT=9000` → http://localhost:9000).


## Updating

```bash
docker compose pull
docker compose up -d
```

**`docker compose up -d` on its own is not enough.** The images are pinned to `:latest`, and Docker reuses a
tag it already has rather than checking for a newer one — so without the `pull` you stay on whatever version
you first installed, indefinitely, with nothing to tell you. Watch
[releases](https://github.com/AngeloSha/uchiyomi/releases) to know when there is something to pull.

Upgrading in place is safe: accounts, reading progress, downloads and settings live in named volumes, and the
database migrates itself on boot.

> The two upgrade warnings that used to sit here — empty backups on v0.9.0/v0.9.1, and volume ownership
> before v0.5.1 — were about releases fourteen and nineteen versions back. They are in the
> [changelog](../CHANGELOG.md) with the same detail, which is where release history belongs.

## Behind a domain (HTTPS)

The compose file is **standalone**: it publishes the app on a local port and creates its own private networks,
so a fresh install just works. To put it on a public domain with TLS, front the app with any reverse proxy
(Caddy, Traefik, Nginx Proxy Manager, …) and set `PUBLIC_ORIGIN` in `.env` to your URL.

If your proxy reaches containers over a shared Docker network, drop a `docker-compose.override.yml` next to the
compose file — Compose loads it automatically:

```yaml
# docker-compose.override.yml  (server-specific; keep it out of git)
networks:
  proxy:
    external: true
services:
  uchiyomi:
    networks: [uchiyomi_app, uchiyomi_internal, proxy]   # keep the first two: the solver, and the database
```

Point the proxy at **`uchiyomi` port 3000**. Once it reaches the app over a shared Docker network you no
longer need the published host port, and deleting the `ports:` entry stops the app also being served over
plain HTTP alongside your HTTPS domain.

> Using the development stack from a clone instead? Its services are named `yomi-*`, with networks
> `yomi_app` and `yomi_internal`.
