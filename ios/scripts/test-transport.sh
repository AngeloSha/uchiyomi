#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
output="${UCHI_NATIVE_TEST_OUTPUT:-${TMPDIR:-/tmp}/uchiyomi-native-transport-$$}"
mkdir -p "$output"
swiftc -swift-version 5 Sources/Core/HTTP.swift Tests/TransportTests/main.swift -o "$output/transport-tests"
"$output/transport-tests"
