#!/bin/sh
# Run as the uid that actually owns your library, then drop privileges.
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
set -eu

APP_UID="${PUID:-10002}"
APP_GID="${PGID:-10002}"

# Not root: someone set `user:` in compose, which bypasses this script's ability to adjust anything. Say so
# plainly and carry on rather than failing, because it is a legitimate way to run the container.
if [ "$(id -u)" != "0" ]; then
  echo "[entrypoint] running as uid $(id -u); PUID/PGID ignored (the container was not started as root)"
  exec "$@"
fi

if [ "$APP_UID" = "0" ]; then
  echo "[entrypoint] refusing to run the app as root. Set PUID/PGID to the owner of your library." >&2
  exit 1
fi

CUR_UID="$(id -u yomi)"
CUR_GID="$(id -g yomi)"

if [ "$APP_GID" != "$CUR_GID" ]; then
  # A group with this gid may already exist under another name; reuse it rather than failing.
  if getent group "$APP_GID" >/dev/null 2>&1; then
    usermod -g "$APP_GID" yomi 2>/dev/null || deluser yomi >/dev/null 2>&1
  else
    groupmod -g "$APP_GID" yomi
  fi
fi
[ "$APP_UID" != "$CUR_UID" ] && usermod -u "$APP_UID" yomi

# Only the volumes the app owns. NEVER /library: that is the user's collection, and taking ownership of it is
# the exact thing PUID exists to avoid.
#
# The recursion is conditional because /cache holds tens of thousands of files (61,336 / 11.3 GB on the
# instance this was written against) and a blind `chown -R` would stat every one of them on every single
# container start, to change nothing.
for d in /config /library-dl /backups /cache; do
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

exec su-exec "$APP_UID:$APP_GID" "$@"
