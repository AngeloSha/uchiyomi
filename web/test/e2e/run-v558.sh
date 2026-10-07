#!/usr/bin/env bash
# The v0.55.8 browser acceptance gate. Each phase gets the fresh instance its walk requires, but every instance
# resolves and runs the same already-built AIO image ID (up.sh refuses skip mode without an explicit image).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE=${E2E_IMAGE:?E2E_IMAGE must name the AIO image built once for this gate}

run_phase() {
  local phase=$1 port=$2 subnet=$3
  shift 3
  echo "· v0.55.8 browser phase: $phase"
  env "$@" \
    E2E_SKIP_BUILD=1 E2E_IMAGE="$IMAGE" E2E_MIN_FREE_GB=0 \
    E2E_WALK_SCRIPT=test/e2e/walk49.mjs PHASES="$phase" \
    OUT="test/e2e/shots-v558/$phase" \
    E2E_NET="uchiyomi-e2e-v558-$phase" E2E_PORT="$port" E2E_SUBNET="$subnet" \
    bash "$HERE/up.sh"
}

# The walk documents these as separate-stack phases: state from one must never make the next one pass.
run_phase librarysort    18158 10.222.18.0/24
run_phase homelists      18159 10.222.19.0/24
run_phase anilistprivacy 18160 10.222.20.0/24 E2E_ANILIST=1
run_phase bulkdelete     18161 10.222.21.0/24
