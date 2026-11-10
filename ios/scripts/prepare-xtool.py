#!/usr/bin/env python3
"""Stage the canonical native sources for pinned xtool; no Xcode project is rewritten."""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
IOS = ROOT / 'ios'
MARKER = '.uchiyomi-xtool-staging'

def prepare(output, *, version='0.1.0', build='2026111001', sdk_version='27.2'):
    if not re.fullmatch(r'(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)', version):
        raise ValueError('Use a numeric native version')
    if not re.fullmatch(r'[1-9][0-9]{0,15}', build):
        raise ValueError('Use a positive integer build number')
    if not re.fullmatch(r'[0-9]+\.[0-9]+(?:\.[0-9]+)?', sdk_version) or tuple(map(int, sdk_version.split('.')[:2])) < (27, 1):
        raise ValueError('Use an installed iPhone SDK version of 27.1 or newer')
    output = Path(output).resolve()
    if output == ROOT or ROOT.is_relative_to(output) or output == IOS or output.is_relative_to(IOS / 'Sources'):
        raise ValueError('Staging must not replace the repository or canonical sources')
    if output.exists() and not (output / MARKER).is_file():
        raise ValueError('Refusing to replace a directory not owned by this staging script')
    output.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='uchiyomi-xtool-', dir=output.parent))
    try:
        (stage / MARKER).write_text('Generated staging files; canonical source is ios/Sources.\n')
        target = stage / 'Sources' / 'Uchiyomi'
        records = []
        for subtree in ['App', 'Core']:
            for source in sorted((IOS / 'Sources' / subtree).rglob('*.swift')):
                destination = target / subtree / source.relative_to(IOS / 'Sources' / subtree)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
                records.append({'path': str(source.relative_to(ROOT)), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()})
        resources = target / 'Resources'
        resources.mkdir()
        brand = IOS / 'Sources/App/Assets.xcassets/BrandMark.imageset/uchiyomi-mark.png'
        icon = IOS / 'Sources/App/Assets.xcassets/AppIcon.appiconset/AppIcon.png'
        shutil.copyfile(brand, resources / 'BrandMark.png')
        shutil.copyfile(icon, stage / 'AppIcon.png')
        info_source = IOS / 'Config/Info.plist'
        info = plistlib.loads(info_source.read_bytes())
        info.update(CFBundleIdentifier='com.uchiyomi.reader', CFBundleName='Uchiyomi', CFBundleExecutable='Uchiyomi',
                    CFBundleShortVersionString=version, CFBundleVersion=build, MinimumOSVersion='17.0',
                    CFBundleSupportedPlatforms=['iPhoneOS'], UIDeviceFamily=[1, 2])
        encoded = plistlib.dumps(info)
        if b'$(' in encoded:
            raise ValueError('Unresolved Xcode setting in staged Info.plist')
        (stage / 'Info.plist').write_bytes(encoded)
        package = '''// swift-tools-version: 5.9
import PackageDescription
let package = Package(
    name: "Uchiyomi",
    platforms: [.iOS(.v17)],
    products: [.library(name: "Uchiyomi", targets: ["Uchiyomi"])],
    targets: [.target(name: "Uchiyomi", path: "Sources/Uchiyomi",
                                resources: [.copy("Resources/BrandMark.png")],
                                linkerSettings: [.unsafeFlags(["-Xlinker", "-platform_version", "-Xlinker", "ios", "-Xlinker", "17.0", "-Xlinker", "__IOS_SDK_VERSION__"])])]
)
'''
        (stage / 'Package.swift').write_text(package.replace('__IOS_SDK_VERSION__', sdk_version))
        (stage / 'xtool.yml').write_text('''version: 1
bundleID: com.uchiyomi.reader
infoPath: Info.plist
iconPath: AppIcon.png
''')
        for source in [brand, icon, info_source, Path(__file__).resolve(), IOS / "scripts/build-linux.sh", IOS / "scripts/inspect-linux-ipa.py"]:
            records.append({'path': str(source.relative_to(ROOT)), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()})
        fingerprint = hashlib.sha256(json.dumps(records, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        record = {'xtoolVersion': '1.24.0', 'iPhoneSDKVersion': sdk_version, 'nativeProtocolVersion': 2, 'offlineSchemaVersion': 2,
                  'version': version, 'build': build, 'nativeSourceSha256': fingerprint,
                  'sourceRevision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
                  'sourceDirty': bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT)),
                  'files': records, 'physicalDeviceVerified': False, 'published': False}
        (stage / 'native-source.json').write_text(json.dumps(record, indent=2) + '\n')
        if output.exists():
            shutil.rmtree(output)
        stage.rename(output)
        return record
    finally:
        if stage.exists():
            shutil.rmtree(stage)

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--version', default='0.1.0')
    parser.add_argument('--build', default='2026111001')
    parser.add_argument('--sdk-version', default='27.2')
    args = parser.parse_args()
    record = prepare(args.output, version=args.version, build=args.build, sdk_version=args.sdk_version)
    print(json.dumps({k: record[k] for k in ['xtoolVersion', 'version', 'build', 'nativeSourceSha256', 'published']}, indent=2))
