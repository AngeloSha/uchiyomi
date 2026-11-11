#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
[[ -f web/out/mobile-assets.json ]] || { echo 'Build web/out before running WebKit tests' >&2; exit 1; }
output="${1:-ios/build/WebViewCI}"
[[ ! -e "$output" ]] || { echo "Output already exists: $output" >&2; exit 1; }
mkdir -p "$output"
node ios/scripts/prepare-webview-fixture.mjs
simulator="${UCHI_SIMULATOR_ID:-}"
device_type="${UCHI_SIMULATOR_DEVICE_TYPE:-com.apple.CoreSimulator.SimDeviceType.iPhone-16-Pro}"
created=false
cleanup() {
  if [[ "$created" == true ]]; then
    xcrun simctl shutdown "$simulator" >/dev/null 2>&1 || true
    xcrun simctl delete "$simulator" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
xcrun simctl list runtimes --json > "$output/runtimes.json"
sdk="$(xcrun --sdk iphonesimulator --show-sdk-version)"
runtime_args=(--runtimes "$output/runtimes.json" --sdk "$sdk" --device-type "$device_type")
if [[ -n "${UCHI_SIMULATOR_RUNTIME_BUILD:-}" ]]; then
  runtime_args+=(--build "$UCHI_SIMULATOR_RUNTIME_BUILD")
fi
if [[ -n "$simulator" ]]; then
  xcrun simctl list devices --json > "$output/devices.json"
  runtime_args+=(--simulator "$simulator" --devices "$output/devices.json")
fi
runtime="$(python3 ios/scripts/select-simulator-runtime.py "${runtime_args[@]}")"
if [[ -z "$simulator" ]]; then
  simulator="$(xcrun simctl create 'Uchiyomi CI' "$device_type" "$runtime")"
  created=true
fi
xcrun simctl bootstatus "$simulator" -b
# Keep simulator signing enabled: the Keychain fixture needs it. No Apple team is needed.
build_args=(-project ios/Uchiyomi.xcodeproj -scheme Uchiyomi -configuration Debug
  -destination "platform=iOS Simulator,id=$simulator"
  -derivedDataPath "$output/DerivedData"
  -test-timeouts-enabled YES -default-test-execution-time-allowance 300 -maximum-test-execution-time-allowance 600
  ONLY_ACTIVE_ARCH=YES
  DEVELOPMENT_TEAM= CODE_SIGN_IDENTITY=- PRODUCT_BUNDLE_IDENTIFIER=org.uchiyomi.ci
  UCHI_TEST_BUNDLE_IDENTIFIER=org.uchiyomi.ci.tests)
auth_test=UchiyomiWebViewTests/CachedWebViewTests/testExpiredIdentityAccountBoundaryAndOfflineLogout
# These fixtures replace many WebKit processes/stores. Hosted simulators can stall
# later fixtures in the same test host, including cookie and IndexedDB operations.
# Run each in a fresh host, as for authentication. Every invocation must pass;
# no assertion is skipped or retried, and every result bundle is retained.
cache_tests=(
  UchiyomiWebViewTests/CachedWebViewTests/testAutomaticUIUpdateAndFailedStartupRecoveryPreserveOfflineData
  UchiyomiWebViewTests/CachedWebViewTests/testPreparedReaderWithUnavailableServer
  UchiyomiWebViewTests/CachedWebViewTests/testTwoServerProfilesWithSameAccountAndChapterIDsAndConfirmedRemoval
)
skip_cache=()
for cache_test in "${cache_tests[@]}"; do
  skip_cache+=("-skip-testing:$cache_test")
done
xcodebuild "${build_args[@]}" -resultBundlePath "$output/tests.xcresult" \
  -skip-testing:"$auth_test" "${skip_cache[@]}" test 2>&1 | tee "$output/test.log"
for cache_test in "${cache_tests[@]}"; do
  xcodebuild "${build_args[@]}" -resultBundlePath "$output/${cache_test##*/}.xcresult" \
    -only-testing:"$cache_test" test-without-building 2>&1 | tee -a "$output/test.log"
done
xcodebuild "${build_args[@]}" -resultBundlePath "$output/auth.xcresult" \
  -only-testing:"$auth_test" test-without-building 2>&1 | tee -a "$output/test.log"
