#!/usr/bin/env bash
# S6: the unsigned (ad-hoc) macOS build.
#   1. codesign: the app AND the nested postgres/initdb/pg_dump carry a valid signature (arm64 refuses to exec
#      unsigned code), and what KIND of signature each one has.
#   2. The shipped DMG, copied out the way a user drags it (no quarantine, as from a terminal): boots postgres +
#      bff to a 200 /healthz.
#   3. Quarantined like a Safari download: what Gatekeeper says (spctl), and what happens to a quarantined nested
#      binary and a quarantined launch. The "Open Anyway" click itself is GUI-only and cannot run in CI.
set -u
DESKTOP="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$DESKTOP/ci-out"
mkdir -p "$OUT"
REC="node $DESKTOP/scripts/ci/record.mjs"
T="${RUNNER_TEMP:-/tmp}/s6"
rm -rf "$T"; mkdir -p "$T"
APP=$(ls -d "$DESKTOP"/dist/mac*/Uchiyomi.app | head -1)
DMG=$(ls "$DESKTOP"/dist/*.dmg | head -1)
ZIP=$(ls "$DESKTOP"/dist/*.zip | head -1)
echo "app=$APP dmg=$DMG zip=$ZIP arch=$(uname -m)"
# Every step that could wait on a Gatekeeper/Keychain prompt gets a hard timeout: perl's alarm (macOS has no timeout(1)).
t() { local s=$1; shift; perl -e 'alarm shift; exec @ARGV' "$s" "$@"; }
# A command that may block INSIDE exec (a quarantined binary waiting on Gatekeeper) ignores alarms, so the probes
# below run in the background and are abandoned, not awaited, when their time is up: bgt <secs> <out> cmd...
bgt() {
  local s=$1 out=$2; shift 2
  rm -f "$out" "$out.rc"
  ( "$@" > "$out" 2>&1; echo $? > "$out.rc" ) &
  local p=$! i
  for i in $(seq 1 "$s"); do [ -f "$out.rc" ] && { cat "$out.rc"; return; }; sleep 1; done
  pkill -9 -P "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null
  echo timeout
}

# ---------------------------------------------------------------- 1. signatures
SIG="$OUT/s6-codesign.txt"
: > "$SIG"
kind() {  # adhoc | developer-id:<authority> | unsigned | invalid
  local f="$1" d
  d=$(codesign -dv --verbose=4 "$f" 2>&1)
  if echo "$d" | grep -q "code object is not signed"; then echo unsigned; return; fi
  if ! codesign --verify --strict "$f" >/dev/null 2>&1; then echo "invalid"; return; fi
  if echo "$d" | grep -q "Signature=adhoc"; then echo adhoc; return; fi
  echo "signed:$(echo "$d" | grep -m1 '^Authority=' | cut -d= -f2)"
}
SHARP=$(ls "$APP"/Contents/Resources/bff/node_modules/@img/sharp-darwin-*/lib/*.node 2>/dev/null | head -1)
ARGON=$(ls "$APP"/Contents/Resources/bff/node_modules/@node-rs/argon2-darwin-*/*.node 2>/dev/null | head -1)
declare -a FILES=("$APP" "$APP/Contents/MacOS/Uchiyomi" "$APP/Contents/Frameworks/Electron Framework.framework"
  "$APP/Contents/Resources/pg/bin/postgres" "$APP/Contents/Resources/pg/bin/initdb" "$APP/Contents/Resources/pg/bin/pg_ctl"
  "$APP/Contents/Resources/pg/bin/pg_dump" "$APP/Contents/Resources/pg/bin/psql" "$APP/Contents/Resources/pg/lib/libpq.5.dylib"
  "$APP/Contents/Resources/pg/lib/postgresql/plpgsql.dylib" "$SHARP" "$ARGON")
KINDS="{"
for f in "${FILES[@]}"; do
  [ -e "$f" ] || { echo "MISSING $f" >> "$SIG"; continue; }
  k=$(kind "$f")
  rel="${f#$APP/}"
  echo "== $rel -> $k" >> "$SIG"
  codesign -dv --verbose=4 "$f" 2>&1 | grep -E "^(Identifier|Format|CodeDirectory|Signature|Authority|TeamIdentifier|Runtime)" >> "$SIG"
  lipo -archs "$f" >/dev/null 2>&1 && echo "archs: $(lipo -archs "$f")" >> "$SIG"
  KINDS="$KINDS\"$(basename "$rel")\":\"$k\","
done
KINDS="${KINDS%,}}"
DEEP=$(t 180 codesign --verify --deep --strict --verbose=2 "$APP" 2>&1); DEEP_RC=$?
echo "== deep verify rc=$DEEP_RC" >> "$SIG"; echo "$DEEP" >> "$SIG"
cat "$SIG"
APPK=$(kind "$APP"); PGK=$(kind "$APP/Contents/Resources/pg/bin/postgres"); IDK=$(kind "$APP/Contents/Resources/pg/bin/initdb"); DK=$(kind "$APP/Contents/Resources/pg/bin/pg_dump")
echo "{\"kinds\":$KINDS,\"deepVerifyRc\":$DEEP_RC}" > "$T/ev1.json"
V=FAIL
if [ "$APPK" = adhoc ] && [ "$DEEP_RC" = 0 ] && [[ "$PGK" != unsigned && "$PGK" != invalid ]] && [[ "$IDK" != unsigned && "$IDK" != invalid ]] && [[ "$DK" != unsigned && "$DK" != invalid ]]; then V=PASS; fi
$REC S6-signatures "$V" "app=$APPK; postgres=$PGK; initdb=$IDK; pg_dump=$DK; codesign --verify --deep --strict rc=$DEEP_RC (full list ci-out/s6-codesign.txt)" "$T/ev1.json"

# ---------------------------------------------------------------- 2. the DMG, launched from a terminal
MNT="$T/mnt"
mkdir -p "$MNT"
echo "S6: attaching the dmg"
t 180 hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$MNT" "$DMG"
cp -R "$MNT/Uchiyomi.app" "$T/Uchiyomi.app"
hdiutil detach "$MNT" >/dev/null || hdiutil detach -force "$MNT" >/dev/null
QBEFORE=$(xattr -lr "$T/Uchiyomi.app" 2>/dev/null | grep -c quarantine)
START=$(date +%s)
echo "S6: smoke from the dmg copy"
t 360 "$T/Uchiyomi.app/Contents/MacOS/Uchiyomi" --smoke --data-dir="$T/data" --result="$T/smoke.json" > "$OUT/s6-dmg-smoke.log" 2>&1
RC=$?
END=$(date +%s)
HZ=$(node -e "const r=require('$T/smoke.json');console.log(r.checks.healthz&&r.checks.healthz.status, r.ok, r.checks.bffBackup&&r.checks.bffBackup.pass)" 2>/dev/null)
cp "$T/smoke.json" "$OUT/s6-dmg-smoke.json" 2>/dev/null
V=FAIL; [ "$RC" = 0 ] && V=PASS
$REC S6-dmg-terminal-launch "$V" "copied out of $(basename "$DMG") (quarantine xattrs: $QBEFORE), --smoke exit $RC in $((END-START)) s; healthz/ok/bffBackup: $HZ" "$T/smoke.json"

# The zip is what an updater would unpack: it must keep the signatures intact.
echo "S6: zip integrity"
t 300 ditto -x -k "$ZIP" "$T/zip"
ZV=$(t 180 codesign --verify --deep --strict "$T/zip/Uchiyomi.app" 2>&1); ZRC=$?
$REC S6-zip-integrity "$([ $ZRC = 0 ] && echo PASS || echo FAIL)" "$(basename "$ZIP") unpacked with ditto: codesign --verify --deep --strict rc=$ZRC ${ZV:0:200}"

# ---------------------------------------------------------------- 3. quarantine
echo "S6: quarantine"
GK=$(t 30 spctl --status 2>&1)
xattr -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" "$T/Uchiyomi.app"
SP=$(t 120 spctl --assess --type execute -vv "$T/Uchiyomi.app" 2>&1); SPRC=$?
echo "$SP"
# A real download quarantines every file, not only the bundle.
mkdir -p "$T/q"
cp -R "$T/Uchiyomi.app" "$T/q/Uchiyomi.app"
xattr -r -w com.apple.quarantine "0081;$(printf %x "$(date +%s)");Safari;" "$T/q/Uchiyomi.app"
echo "S6: exec a quarantined nested binary"
NRC=$(bgt 30 "$T/nested.txt" "$T/q/Uchiyomi.app/Contents/Resources/pg/bin/pg_ctl" --version); NESTED=$(cat "$T/nested.txt" 2>/dev/null)
echo "S6: terminal launch of the quarantined app"
QRC=$(bgt 90 "$OUT/s6-quarantined-smoke.log" "$T/q/Uchiyomi.app/Contents/MacOS/Uchiyomi" --smoke --data-dir="$T/qdata" --result="$T/qsmoke.json")
QOK=$(node -e "try{const r=require('$T/qsmoke.json');console.log(r.ok)}catch{console.log('no-result')}")
echo "S6: open (LaunchServices) on the quarantined copy"
ORC=$(bgt 30 "$T/open.txt" open -n "$T/q/Uchiyomi.app" --args --smoke --data-dir="$T/odata" --result="$T/osmoke.json")
sleep 45
OOK=$(node -e "try{const r=require('$T/osmoke.json');console.log(r.ok)}catch{console.log('no-result')}")
pkill -9 -f "$T/q/Uchiyomi.app" 2>/dev/null || true
cat > "$T/ev3.json" <<EOF
{"gatekeeper":$(node -e "console.log(JSON.stringify(process.argv[1]))" "$GK"),"spctl":$(node -e "console.log(JSON.stringify(process.argv[1]))" "$SP"),"spctlRc":$SPRC,
 "quarantinedNestedPgCtl":{"rc":"$NRC","out":$(node -e "console.log(JSON.stringify(process.argv[1]))" "$NESTED")},
 "quarantinedTerminalSmoke":{"rc":"$QRC","ok":"$QOK"},"quarantinedOpen":{"rc":"$ORC","ok":"$OOK"}}
EOF
cat "$T/ev3.json"
V=INFO
if echo "$SP" | grep -q "rejected"; then V=EXPECTED; fi
$REC S6-quarantine "$V" "Gatekeeper: $(echo "$GK" | tr '\n' ' '); spctl --assess on the quarantined app: rc=$SPRC \"$(echo "$SP" | tr '\n' ' ' | cut -c1-200)\"; all-files quarantine: nested pg_ctl rc=$NRC, terminal launch rc=$QRC ok=$QOK, 'open' launch ok=$OOK. The GUI 'Open Anyway' click cannot run in CI." "$T/ev3.json"
