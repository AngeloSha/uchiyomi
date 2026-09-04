#!/bin/sh
# Run as the uid that actually owns your library, then drop privileges -- and, when no database was given,
# run one.
#
# Uchiyomi can rename and delete files in your library now, and a container running as uid 10002 cannot write
# a library owned by you. The usual fix people are told is `chown -R 10002 /your/manga`, which takes ownership
# of a personal media collection that a NAS share, another app and your own login also use. So instead this
# runs as YOUR uid, the linuxserver.io convention that most self-hosters already expect, and your files stay
# yours.
#
# WITH PUID/PGID UNSET THIS MUST BE A NO-OP. An existing install keeps running as 10002, byte for byte, and
# never starts as root at all. That is not politeness: v0.5.1 was entirely a volume-ownership bug (a fresh
# install could not write /config, so the JWT secret could not be saved and everyone was signed out on every
# restart), and this script is now the thing standing between that failure and a repeat of it.
#
# EMBEDDED POSTGRES. With DATABASE_URL unset, this starts a Postgres of its own on a unix socket, in /data/pg,
# and points the app at it; with DATABASE_URL set, nothing below the "embedded" line runs and the container
# behaves exactly as it always has. That one variable is the whole switch, so an existing install with an
# external database cannot drift into this path by accident.
#
# Why an entrypoint and not an init system: if Postgres dies the right outcome is for the CONTAINER to exit
# and `restart: unless-stopped` to bring both halves back in order, which is the opposite of what an init
# system's restart-the-service semantics would do to a database. tini stays PID 1; this script is the
# supervisor for exactly two processes and knows which one is the database.
set -eu

APP_UID="${PUID:-10002}"
APP_GID="${PGID:-10002}"
PGDATA="${PGDATA:-/data/pg}"
PGSOCK="${PGSOCK:-/run/postgresql}"
EMBEDDED=0
[ -z "${DATABASE_URL:-}" ] && EMBEDDED=1

ROOT=0
[ "$(id -u)" = "0" ] && ROOT=1

if [ "$ROOT" = 1 ] && [ "$APP_UID" = "0" ]; then
  echo "[entrypoint] refusing to run the app as root. Set PUID/PGID to the owner of your library." >&2
  exit 1
fi

# Run something as the app user. Root drops with su-exec; a container started with `user:` is already the
# app user and just runs it. Postgres refuses to run as root, so the embedded database needs this too.
as_app() {
  if [ "$ROOT" = 1 ]; then su-exec "$APP_UID:$APP_GID" "$@"; else "$@"; fi
}

if [ "$ROOT" = 1 ]; then
  # Deliberately NO usermod/groupmod. The base image already ships a user at uid 1000 (node), so renumbering
  # the app user collides with it and the container crash-loops on "UID '1000' already exists" -- which is
  # exactly what happened the first time this ran against a real library owned by uid 1000.
  #
  # su-exec takes numeric ids, and nothing in the app resolves its own username, so the app user simply does
  # not need to own the number. Dropping this also drops the shadow dependency.

  # Only the volumes the app owns. NEVER /library: that is the user's collection, and taking ownership of it is
  # the exact thing PUID exists to avoid.
  #
  # The recursion is conditional because /cache holds tens of thousands of files (61,336 / 11.3 GB on the
  # instance this was written against) and a blind `chown -R` would stat every one of them on every single
  # container start, to change nothing. /data is the embedded database's volume and is only ever created here.
  for d in /config /library-dl /backups /cache /data; do
    [ -d "$d" ] || continue
    owner="$(stat -c '%u' "$d" 2>/dev/null || echo '')"
    if [ "$owner" != "$APP_UID" ]; then
      echo "[entrypoint] taking ownership of $d ($owner -> $APP_UID)"
      chown -R "$APP_UID:$APP_GID" "$d" || echo "[entrypoint] warning: could not chown $d" >&2
    fi
  done

  # One line that answers "why did my rename fail" from `docker compose logs` alone, without anyone having to
  # exec into the container to find out which uid is running.
  if [ -d /library ]; then
    if su-exec "$APP_UID:$APP_GID" test -w /library; then
      echo "[entrypoint] uid $APP_UID: /library is writable, file operations are available"
    else
      lib_owner="$(stat -c '%u' /library 2>/dev/null || echo '?')"
      echo "[entrypoint] uid $APP_UID: /library is READ-ONLY (owned by uid $lib_owner)."
      echo "[entrypoint]   Renaming and deleting files is unavailable. To enable it, set PUID=$lib_owner"
      echo "[entrypoint]   (and PGID to its group) in your .env and restart. Everything else works as normal."
    fi
  fi
else
  # Not root: someone set `user:` in compose, which bypasses this script's ability to adjust anything. Say so
  # plainly and carry on rather than failing, because it is a legitimate way to run the container.
  echo "[entrypoint] running as uid $(id -u); PUID/PGID ignored (the container was not started as root)"
fi

if [ "$EMBEDDED" = 0 ]; then
  # An external database: the path every install before embedded Postgres took, unchanged.
  if [ "$ROOT" = 1 ]; then exec su-exec "$APP_UID:$APP_GID" "$@"; else exec "$@"; fi
fi

# ---------------------------------------------------------------- embedded -------------------------------
# Socket only: listen_addresses is empty, so nothing outside this container can reach the database at all,
# and there is no password to manage. The socket directory is /run/postgresql when this uid may write there
# (root arranges it; the image pre-creates it for the default uid) and a temp directory otherwise.
mkdir -p "$PGDATA" "$PGSOCK" 2>/dev/null || true
if [ "$ROOT" = 1 ]; then
  chown "$APP_UID:$APP_GID" "$PGDATA" "$PGSOCK"
fi
if ! as_app test -w "$PGSOCK" 2>/dev/null; then
  PGSOCK=/tmp/pgsock
  mkdir -p "$PGSOCK"
fi
if ! as_app test -w "$PGDATA" 2>/dev/null; then
  echo "[entrypoint] $PGDATA is not writable by uid $(as_app id -u). The embedded database needs a writable /data volume." >&2
  exit 1
fi
as_app chmod 700 "$PGDATA"

# Postgres refuses to run as a uid with no passwd entry -- initdb says "could not look up effective user ID
# 1003: user does not exist" -- and PUID is usually exactly that: the owner of the library, who exists on the
# host and not in this image. That was the first thing the real boot found, after every fake had passed.
# Two remedies, in order. As root, add an entry for the uid (adding, never renumbering: the comment above
# about usermod stands, and a uid that already has an entry, like node's 1000, is left alone). Not root, or
# if that fails, answer the lookup through nss_wrapper from a file, which is what the official postgres image
# does for arbitrary --user values. Neither working is a real limit, and it is said plainly.
ensure_passwd_entry() {
  uid="$(as_app id -u)"; gid="$(as_app id -g)"
  if getent passwd "$uid" >/dev/null 2>&1; then return 0; fi
  if [ "$ROOT" = 1 ]; then
    getent group "$gid" >/dev/null 2>&1 || addgroup -g "$gid" "app$gid" >/dev/null 2>&1 || true
    grp="$(getent group "$gid" 2>/dev/null | cut -d: -f1)"
    if adduser -D -H -u "$uid" -G "${grp:-nogroup}" "app$uid" >/dev/null 2>&1; then
      echo "[entrypoint] added a passwd entry for uid $uid so Postgres can run as it"
      return 0
    fi
  fi
  nss="${NSS_WRAPPER_LIB:-/usr/lib/libnss_wrapper.so}"
  if [ -f "$nss" ]; then
    printf 'app%s:x:%s:%s:app:/tmp:/bin/sh\n' "$uid" "$uid" "$gid" > /tmp/nss-passwd
    printf 'app%s:x:%s:\n' "$gid" "$gid" > /tmp/nss-group
    export LD_PRELOAD="$nss" NSS_WRAPPER_PASSWD=/tmp/nss-passwd NSS_WRAPPER_GROUP=/tmp/nss-group
    echo "[entrypoint] uid $uid has no passwd entry; Postgres will run as it through nss_wrapper"
    return 0
  fi
  echo "[entrypoint] uid $uid has no passwd entry and nss_wrapper is not available, so Postgres cannot start as it." >&2
  echo "[entrypoint]   Use PUID/PGID (the container then adds the entry) rather than 'user:', or set DATABASE_URL." >&2
  return 1
}
ensure_passwd_entry || exit 1

# A data directory from a different Postgres major cannot be opened by this server, and the error Postgres
# gives for that is not one anyone should have to decode from a crash loop. Refuse up front and say where the
# upgrade path is written down.
SERVER_MAJOR="$(pg_ctl --version | sed -E 's/^.*\) ([0-9]+).*$/\1/')"
if [ -s "$PGDATA/PG_VERSION" ]; then
  DATA_MAJOR="$(cat "$PGDATA/PG_VERSION")"
  if [ "$DATA_MAJOR" != "$SERVER_MAJOR" ]; then
    echo "[entrypoint] the database in $PGDATA is Postgres $DATA_MAJOR and this image ships Postgres $SERVER_MAJOR." >&2
    echo "[entrypoint]   It needs upgrading before it can be opened: see docs/MIGRATING.md#postgres-upgrade." >&2
    exit 1
  fi
else
  echo "[entrypoint] first start: initialising embedded Postgres $SERVER_MAJOR in $PGDATA"
  # UTF-8 with C collation: musl has no real locales, so this is what the official alpine image gets too, and
  # it is the ordering every existing install already has. --auth=trust is fine on a socket nobody else can
  # reach; there is no network listener to protect.
  as_app initdb -D "$PGDATA" -U yomi -E UTF8 --locale=C --auth=trust --auth-local=trust >/dev/null
fi

# The server's own log goes to the container log with the app's, rather than to a file inside the volume
# that nothing rotates. Started with -w so the app never races a database that is still recovering.
echo "[entrypoint] starting embedded Postgres $SERVER_MAJOR (socket $PGSOCK)"
as_app pg_ctl -D "$PGDATA" -w -t 60 -l /dev/stdout \
  -o "-c listen_addresses='' -k $PGSOCK -c log_min_messages=warning" start >/dev/null
if ! as_app psql -h "$PGSOCK" -U yomi -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='yomi'" | grep -q 1; then
  as_app createdb -h "$PGSOCK" -U yomi yomi
fi

export DATABASE_URL="postgres://yomi@/yomi?host=$PGSOCK"
export EMBEDDED_DB=1
# The healthcheck cannot see this shell's environment, so it reads a marker instead.
: > "$PGSOCK/.embedded"

# Supervise. The app runs in the background so this shell can forward SIGTERM to it (it finishes the chapter
# it is writing; server.ts caps that itself) and then stop Postgres cleanly once it has gone. A watcher kills
# the app if Postgres dies underneath it, so the container exits and gets restarted whole. The exit code is
# the app's, so `docker ps` tells the truth about why the container stopped.
stop_pg() {
  echo "[entrypoint] stopping embedded Postgres"
  as_app pg_ctl -D "$PGDATA" -m fast -w -t 30 stop >/dev/null 2>&1 || true
  rm -f "$PGSOCK/.embedded"
}
# NOT through as_app: a shell function run in the background is a subshell, so $! would be the subshell and
# a signal sent to it would never reach the app inside -- the app would be orphaned, still running, while
# this script stopped Postgres underneath it. A plain background command forks straight into the app.
# The app gets neither the preload nor the wrapper files: they exist for Postgres's user lookup alone.
if [ "$ROOT" = 1 ]; then
  env -u LD_PRELOAD -u NSS_WRAPPER_PASSWD -u NSS_WRAPPER_GROUP su-exec "$APP_UID:$APP_GID" "$@" &
else
  env -u LD_PRELOAD -u NSS_WRAPPER_PASSWD -u NSS_WRAPPER_GROUP "$@" &
fi
NODE=$!
trap 'kill -TERM "$NODE" 2>/dev/null || true' TERM INT
(
  while kill -0 "$NODE" 2>/dev/null; do
    sleep 5
    if kill -0 "$NODE" 2>/dev/null && ! as_app pg_ctl -D "$PGDATA" status >/dev/null 2>&1; then
      echo "[entrypoint] embedded Postgres has stopped; stopping the app so the container restarts whole" >&2
      kill -TERM "$NODE" 2>/dev/null || true
      break
    fi
  done
) &
WATCH=$!
set +e
wait "$NODE"; RC=$?
# A signal interrupts wait before the child has exited; wait again to collect its real status.
if [ "$RC" -gt 128 ]; then wait "$NODE"; RC=$?; fi
set -e
kill "$WATCH" 2>/dev/null || true
stop_pg
exit "$RC"
