#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Swift Testing ships with modern Command Line Tools, but its framework/runtime search paths
# are not inferred by every SwiftPM release. Full Xcode supplies them automatically.
developer_dir="${DEVELOPER_DIR:-$(xcode-select -p)}"
if [[ "$developer_dir" == */CommandLineTools ]]; then
    frameworks="$developer_dir/Library/Developer/Frameworks"
    runtime="$developer_dir/Library/Developer/usr/lib"
    swift test --disable-xctest \
        -Xswiftc "-F$frameworks" \
        -Xlinker -rpath -Xlinker "$frameworks" \
        -Xlinker -rpath -Xlinker "$runtime"
else
    swift test --disable-xctest
fi
