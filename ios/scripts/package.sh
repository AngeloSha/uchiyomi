#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
mode="${UCHI_PACKAGE_MODE:-development}"
case "$mode" in development|altstore) ;; *) echo 'UCHI_PACKAGE_MODE must be development or altstore' >&2; exit 1 ;; esac
output="${1:-ios/build/candidate-$(date -u +%Y%m%dT%H%M%SZ)}"
if [[ -e "$output" ]]; then echo "Output already exists: $output" >&2; exit 1; fi
mkdir -p "$output"
output="$(cd "$output" && pwd)"
python3 ios/scripts/source-record.py > "$output/source.json"
settings=()
if [[ -n "${UCHI_BUILD_NUMBER:-}" ]]; then
  if [[ ! "$UCHI_BUILD_NUMBER" =~ ^[1-9][0-9]*$ ]]; then echo 'UCHI_BUILD_NUMBER must be a positive integer' >&2; exit 1; fi
  settings+=("CURRENT_PROJECT_VERSION=$UCHI_BUILD_NUMBER")
fi
version="${UCHI_VERSION:-}"
if [[ -n "${UCHI_RELEASE_TAG:-}" ]]; then
  version="$(PYTHONPATH=ios/scripts python3 -c 'import os; from release_lib import tag_version; print(tag_version(os.environ["UCHI_RELEASE_TAG"]))')"
  if [[ -n "${UCHI_VERSION:-}" && "$UCHI_VERSION" != "$version" ]]; then echo 'Tag and UCHI_VERSION differ' >&2; exit 1; fi
fi
if [[ -n "$version" ]]; then
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Use a numeric three-component UCHI_VERSION' >&2; exit 1; }
  settings+=("MARKETING_VERSION=$version")
fi
if [[ -n "${UCHI_BUNDLE_IDENTIFIER:-}" ]]; then settings+=("PRODUCT_BUNDLE_IDENTIFIER=$UCHI_BUNDLE_IDENTIFIER"); fi
if [[ "$mode" == altstore ]]; then
  bundle="${UCHI_BUNDLE_IDENTIFIER:-$(python3 -c 'import json; print(json.load(open("ios/distribution/listing.json"))["bundleIdentifier"])')}"
  settings+=("PRODUCT_BUNDLE_IDENTIFIER=$bundle" "DEVELOPMENT_TEAM=" "CODE_SIGN_IDENTITY=" "CODE_SIGNING_ALLOWED=NO" "CODE_SIGNING_REQUIRED=NO")
else
  settings+=(-allowProvisioningUpdates)
fi
xcodebuild -project ios/Uchiyomi.xcodeproj -scheme Uchiyomi -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$output/Uchiyomi.xcarchive" \
  -derivedDataPath "$output/DerivedData" "${settings[@]}" archive > "$output/archive.log" 2>&1
app="$output/Uchiyomi.xcarchive/Products/Applications/Uchiyomi.app"
if [[ "$mode" == altstore ]]; then
  [[ ! -e "$app/embedded.mobileprovision" ]] || { echo 'Unexpected provisioning profile in AltStore build' >&2; exit 1; }
  python3 -c 'import plistlib,sys; plistlib.dump({},open(sys.argv[1],"wb"))' "$output/empty-entitlements.plist"
  # A local ad-hoc signature is inspectable without an Apple account/key. AltStore replaces it.
  codesign --force --sign - --timestamp=none --entitlements "$output/empty-entitlements.plist" "$app"
fi
codesign --verify --deep --strict "$app"
codesign -d --verbose=4 --entitlements :- "$app" > "$output/entitlements.plist" 2> "$output/signature.txt"
if [[ "$mode" == development ]]; then security cms -D -i "$app/embedded.mobileprovision" > "$output/provisioning.plist"; fi
mkdir -p "$output/staging/Payload"
ditto "$app" "$output/staging/Payload/Uchiyomi.app"
(cd "$output/staging" && /usr/bin/zip -qry "$output/Uchiyomi.ipa" Payload)
python3 ios/scripts/source-record.py > "$output/source-after.json"
cmp "$output/source.json" "$output/source-after.json"
python3 ios/scripts/inspect-ipa.py "$output" --mode "$mode"
echo "Candidate artifacts: $output"
