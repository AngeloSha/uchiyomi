#!/bin/bash
# Build only. No Apple credentials, signing, device install or publication is performed.
set -euo pipefail
native_root="$(cd "$(dirname "$0")/.." && pwd)"
output="${1:-$native_root/build/private-linux}"
mkdir -p "$output"
output="$(cd "$output" && pwd)"
if [[ "$(xtool --version)" != 'xtool 1.24.0' ]]; then
  echo 'This adapter is tested with pinned xtool 1.24.0.' >&2
  exit 1
fi
# SwiftBuild on Linux otherwise stamps the deployment target as the SDK version. Derive the
# real SDK version from Apple's installed SDKSettings and pass an explicit linker platform version.
native_sdk_version="$(python3 - <<'PYSDK'
import json
from pathlib import Path
import subprocess
configuration = subprocess.check_output(['swift', 'sdk', 'configure', 'darwin', '--show-configuration'], text=True)
paths = {line.removeprefix('sdkRootPath: ').strip() for line in configuration.splitlines()
         if line.startswith('sdkRootPath: ') and '/iPhoneOS.platform/' in line}
if len(paths) != 1:
    raise SystemExit('Expected one installed physical iPhone SDK')
print(json.loads((Path(paths.pop()) / 'SDKSettings.json').read_text())['Version'])
PYSDK
)"
python3 "$native_root/scripts/prepare-xtool.py" "$output/staging" --version "${UCHI_IOS_VERSION:-0.1.0}" --build "${UCHI_IOS_BUILD:-2026111001}" --sdk-version "$native_sdk_version"
cd "$output/staging"
xtool dev build -c release --ipa
python3 - "$native_root" "$output" <<'PY'
from pathlib import Path
import json
import shutil
import subprocess
import sys
native_root, output = map(Path, sys.argv[1:])
ipas = list((output / 'staging').rglob('Uchiyomi.ipa'))
if len(ipas) != 1:
    raise SystemExit('Expected exactly one freshly built Uchiyomi.ipa')
source = json.loads((output / 'staging/native-source.json').read_text())
ipa = output / f"Uchiyomi-{source['version']}-{source['build']}-private.ipa"
shutil.copyfile(ipas[0], ipa)
subprocess.run(['python3', str(native_root / 'scripts/inspect-linux-ipa.py'), str(ipa), '--output', str(output / 'candidate.json')], check=True)
report = json.loads((output / 'candidate.json').read_text())
expected_sdk = [int(v) for v in source['iPhoneSDKVersion'].split('.')]
expected_sdk += [0] * (3 - len(expected_sdk))
if report['buildSDK'] != expected_sdk:
    raise SystemExit('Linked SDK differs from the actual SDK recorded at staging')
shutil.copyfile(output / 'staging/native-source.json', output / 'native-source.json')
PY
