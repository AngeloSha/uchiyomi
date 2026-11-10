#!/usr/bin/env python3
"""Inspect an unsigned xtool IPA without macOS utilities; never claim device/signature verification."""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import plistlib
import struct
import zipfile

def inspect(ipa):
    ipa = Path(ipa)
    with zipfile.ZipFile(ipa) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or archive.testzip() is not None:
            raise ValueError('Duplicate or corrupt IPA entries')
        for name in names:
            p = PurePosixPath(name)
            if p.is_absolute() or '..' in p.parts or '\\' in name:
                raise ValueError('Unsafe IPA path')
            if name != 'Payload/' and not name.startswith('Payload/Uchiyomi.app/'):
                raise ValueError('Unexpected IPA payload')
            if p.name == 'mobile-assets.json' or any(x.endswith(('.xctest', '.appex')) for x in p.parts):
                raise ValueError('Unexpected bundled frontend, tests or extension')
            if p.name == 'embedded.mobileprovision':
                raise ValueError('Personal signing profile in unsigned candidate')
        info = plistlib.loads(archive.read('Payload/Uchiyomi.app/Info.plist'))
        if info['CFBundleIdentifier'] != 'com.uchiyomi.reader' or info['CFBundleSupportedPlatforms'] != ['iPhoneOS']:
            raise ValueError('Not the expected physical-device application')
        if info['WKAppBoundDomains'] != ['localhost'] or info['NSAppTransportSecurity'] != {'NSAllowsLocalNetworking': True}:
            raise ValueError('Unexpected native networking policy')
        if set(info['UIDeviceFamily']) != {1, 2} or info['MinimumOSVersion'] != '17.0':
            raise ValueError('iPhone/iPad or minimum-iOS policy changed')
        if '$(' in repr(info):
            raise ValueError('Unresolved Xcode build setting')
        icon_info = info.get('CFBundleIcons', {}).get('CFBundlePrimaryIcon', {})
        if not any(x.lower().endswith('.png') and 'icon' in x.lower() for x in names) and not icon_info:
            raise ValueError('App icon missing')
        executable = archive.read('Payload/Uchiyomi.app/' + info['CFBundleExecutable'])
        if len(executable) < 32:
            raise ValueError('Native executable missing')
        magic, cpu, _, kind, commands, sizeofcmds, _, _ = struct.unpack_from('<8I', executable)
        if magic != 0xfeedfacf or cpu != 0x0100000c or kind != 2:
            raise ValueError('Expected a 64-bit ARM Mach-O executable, not a host/simulator binary')
        pos = 32
        ios_sdk = None
        for _ in range(commands):
            if pos + 8 > len(executable):
                raise ValueError('Truncated Mach-O load command')
            command, length = struct.unpack_from('<II', executable, pos)
            if length < 8 or pos + length > len(executable):
                raise ValueError('Invalid Mach-O load command')
            if command == 0x32:
                if length < 24:
                    raise ValueError('Invalid build-version command')
                platform, minimum, sdk, _ = struct.unpack_from('<IIII', executable, pos + 8)
                if platform != 2:
                    raise ValueError('Mach-O does not target an iOS device')
                ios_sdk = [sdk >> 16, (sdk >> 8) & 255, sdk & 255]
                if ios_sdk[:2] < [27, 1]:
                    raise ValueError('Use iOS 27.1 SDK or newer')
            pos += length
        if ios_sdk is None:
            raise ValueError('Missing iOS build SDK command')
    return {'artifact': ipa.name, 'sha256': hashlib.sha256(ipa.read_bytes()).hexdigest(),
            'size': ipa.stat().st_size, 'bundleIdentifier': info['CFBundleIdentifier'],
            'version': info['CFBundleShortVersionString'], 'build': info['CFBundleVersion'],
            'nativeProtocolVersion': 2, 'offlineSchemaVersion': 2, 'buildSDK': ios_sdk,
            'distribution': 'unsigned-private-candidate', 'signingRequiredForInstall': True,
            'physicalDeviceVerified': False, 'signatureVerified': False, 'published': False}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('ipa', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    result = inspect(args.ipa)
    text = json.dumps(result, indent=2) + '\n'
    if args.output:
        args.output.write_text(text)
    print(text, end='')
