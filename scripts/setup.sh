#!/usr/bin/env bash
# Yomi one-time secret setup. Run on the server:  bash scripts/setup.sh
# - mints (or accepts) a Komga API key
# - hashes your app login password with argon2id (stored base64; plaintext never persisted)
# - writes them into .env, ensures the yomi DB exists, recreates the BFF
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$DIR/.env"
COMPOSE=(docker compose --project-directory "$DIR" -f "$DIR/docker-compose.yml")

[ -f "$ENV_FILE" ] || { cp "$DIR/.env.example" "$ENV_FILE" 2>/dev/null && echo "Created .env from .env.example"; }
[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE"; exit 1; }

# generate base secrets on first run (idempotent: only fills blanks)
ensure_secret() {
  local key="$1" val
  grep -qE "^${key}=.+" "$ENV_FILE" && return
  val="$(openssl rand -hex 32)"
  if grep -qE "^${key}=" "$ENV_FILE"; then sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"; else echo "${key}=${val}" >> "$ENV_FILE"; fi
  echo "  ✓ generated ${key}"
}
echo "==> Ensuring base secrets…"; ensure_secret DB_PASSWORD; ensure_secret JWT_SECRET

# shellcheck disable=SC1090
DB_PASSWORD="$(grep -E '^DB_PASSWORD=' "$ENV_FILE" | head -1 | cut -d= -f2-)"

echo "==> Building BFF image (needed for hashing + key minting helpers)…"
docker build -q -t yomi-bff:prod "$DIR/bff" >/dev/null

# ---- 1. Content backend (Komga only if LIBRARY_BACKEND=komga) ----------------
LIBRARY_BACKEND="$(grep -E '^LIBRARY_BACKEND=' "$ENV_FILE" | head -1 | cut -d= -f2- || true)"
KOMGA_KEY=""
if [ "${LIBRARY_BACKEND:-owned}" = "komga" ]; then
echo
echo "Komga API key — needed so Yomi can read your Komga library."
read -rp "Paste an existing Komga API key, or leave blank to mint one: " KOMGA_KEY
if [ -z "${KOMGA_KEY:-}" ]; then
  read -rp "  Komga username/email: " KU
  read -rsp "  Komga password: " KP; echo
  echo "  Minting key via http://komga:25600 (internal)…"
  KOMGA_KEY="$(docker run --rm --network proxy_internal -e KU="$KU" -e KP="$KP" yomi-bff:prod node -e '
    const a=Buffer.from(process.env.KU+":"+process.env.KP).toString("base64");
    fetch("http://komga:25600/api/v2/users/me/api-keys",{method:"POST",
      headers:{authorization:"Basic "+a,"content-type":"application/json"},
      body:JSON.stringify({comment:"yomi-bff"})})
      .then(async r=>{ if(!r.ok){console.error("Komga HTTP "+r.status+": "+(await r.text()).slice(0,200));process.exit(2);}
        const j=await r.json(); process.stdout.write(j.key||""); })
      .catch(e=>{console.error(String(e&&e.message||e));process.exit(3);});
  ')"
  [ -n "$KOMGA_KEY" ] || { echo "Failed to mint key."; exit 1; }
  echo "  ✓ Key minted."
fi
else
  echo "==> LIBRARY_BACKEND=owned — reading your own CBZ library (no Komga needed)."
fi

# ---- 2. App login password --------------------------------------------------
echo
echo "App login password — what you'll type to open Yomi on your phone."
read -rsp "  Choose a password (or PIN): " AP1; echo
read -rsp "  Confirm: " AP2; echo
[ "$AP1" = "$AP2" ] || { echo "Passwords don't match."; exit 1; }
[ -n "$AP1" ] || { echo "Empty password."; exit 1; }

echo "  Hashing with argon2id…"
HASH="$(docker run --rm -e PW="$AP1" yomi-bff:prod node -e '
  const {hash}=require("@node-rs/argon2");
  hash(process.env.PW).then(h=>process.stdout.write(h)).catch(e=>{console.error(e.message);process.exit(1);});
')"
[ -n "$HASH" ] || { echo "Hashing failed."; exit 1; }
HASH_B64="$(printf '%s' "$HASH" | base64 -w0)"

# ---- 3. Write .env ----------------------------------------------------------
echo "==> Updating .env"
TMP="$(mktemp)"
grep -v -E '^(KOMGA_API_KEY|INITIAL_USER_PASSWORD_HASH_B64)=' "$ENV_FILE" > "$TMP"
{
  echo "KOMGA_API_KEY=$KOMGA_KEY"
  echo "INITIAL_USER_PASSWORD_HASH_B64=$HASH_B64"
} >> "$TMP"
mv "$TMP" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---- 4. Ensure DB exists, set the live user's password ----------------------
echo "==> Ensuring 'yomi' database exists"
docker exec -e PGPASSWORD="$DB_PASSWORD" yomi-db psql -U yomi -h 127.0.0.1 -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='yomi'" | grep -q 1 \
  || docker exec -e PGPASSWORD="$DB_PASSWORD" yomi-db psql -U yomi -h 127.0.0.1 -d postgres -c "CREATE DATABASE yomi OWNER yomi"

echo "==> Applying live password to existing user (if any)"
docker exec -e PGPASSWORD="$DB_PASSWORD" yomi-db psql -U yomi -h 127.0.0.1 -d yomi -c \
  "UPDATE users SET password_hash = convert_from(decode('$HASH_B64','base64'),'UTF8'), auth_kind='password'" >/dev/null 2>&1 || true

# ---- 5. Recreate BFF --------------------------------------------------------
echo "==> Recreating yomi-bff"
"${COMPOSE[@]}" up -d --force-recreate yomi-bff

# ---- 5b. Volume ownership ---------------------------------------------------
# Docker creates named volumes owned by root:root (0755), but the BFF runs as the non-root app user
# (uid 10002), so it can't write to its cache / downloads / config volumes. Chown them once (idempotent).
echo "==> Setting volume ownership for the app user (uid 10002)"
sleep 1
for dest in /config /library-dl /cache; do
  vol="$(docker inspect yomi-bff --format "{{range .Mounts}}{{if eq .Destination \"$dest\"}}{{.Name}}{{end}}{{end}}" 2>/dev/null || true)"
  if [ -n "$vol" ]; then
    docker run --rm -v "$vol":/v alpine chown -R 10002:10002 /v >/dev/null 2>&1 && echo "  ✓ $dest ($vol)"
  fi
done
# restart so the app boots cleanly with the corrected ownership
"${COMPOSE[@]}" up -d --force-recreate yomi-bff >/dev/null 2>&1 || true

echo
echo "✓ Done. Verifying login…"
sleep 2
if docker run --rm --network proxy_internal -e PW="$AP1" yomi-bff:prod node -e '
  fetch("http://yomi-bff:3000/auth/login",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({password:process.env.PW})}).then(async r=>{
    console.log("login HTTP",r.status); process.exit(r.ok?0:1);}).catch(e=>{console.error(e.message);process.exit(1);});
'; then echo "✓ Login works. Yomi backend is live."; else echo "⚠ Login test failed — check: docker logs yomi-bff"; fi
